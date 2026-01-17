
import React, { useState, useMemo, useCallback } from 'react';
import Header from './components/Header';
import { extractNamesFromExcel } from './services/excelService';
import { processAttendance, extractNamesFromImage } from './services/geminiService';
import { ProcessingResult, AttendanceStatus, MatchSensitivity, Attendee } from './types';
import * as XLSX from 'xlsx';

const App: React.FC = () => {
  // الحالات الأساسية للإدخال
  const [sourceMode, setSourceMode] = useState<'excel' | 'image'>('excel');
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [officialImage, setOfficialImage] = useState<File | null>(null);
  const [excelNamesCount, setExcelNamesCount] = useState<number>(0);
  const [screenshots, setScreenshots] = useState<File[]>([]);
  
  // حالات المعالجة والتحميل
  const [loading, setLoading] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [sensitivity, setSensitivity] = useState<MatchSensitivity>(MatchSensitivity.BALANCED);
  const [error, setError] = useState<string | null>(null);
  
  // حالات النتائج والمراجعة
  const [rawResults, setRawResults] = useState<ProcessingResult | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);
  const [finalResults, setFinalResults] = useState<ProcessingResult | null>(null);
  
  // حالات واجهة المستخدم
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<AttendanceStatus | null>(null);

  // إعادة ضبط التطبيق بالكامل (Reset)
  const resetApp = useCallback(() => {
    if (window.confirm("هل أنت متأكد من رغبتك في بدء تحليل جديد؟ سيتم مسح جميع البيانات الحالية.")) {
      setLoading(false);
      setIsReviewing(false);
      setRawResults(null);
      setFinalResults(null);
      setExcelFile(null);
      setOfficialImage(null);
      setExcelNamesCount(0);
      setScreenshots([]);
      setProgressLog([]);
      setError(null);
      setSearchTerm('');
      setSelectedNames(new Set());
      setSourceMode('excel');
      setShowBulkConfirm(false);
      setPendingStatus(null);
    }
  }, []);

  const getStatusLabel = (status: AttendanceStatus | null) => {
    if (!status) return "غير محدد";
    switch (status) {
      case AttendanceStatus.PRESENT: return "حاضر";
      case AttendanceStatus.ABSENT: return "غائب";
      case AttendanceStatus.UNEXPECTED: return "خارج الكشف";
      default: return "غير محدد";
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = e => reject(e);
    });
  };

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setExcelFile(file);
      setOfficialImage(null);
      setError(null);
      try {
        const names = await extractNamesFromExcel(file);
        setExcelNamesCount(names.length);
      } catch (err) {
        setError("خطأ في قراءة ملف الإكسيل، يرجى التأكد من أن الملف ليس محمياً.");
      }
    }
  };

  const handleOfficialImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setOfficialImage(e.target.files[0]);
      setExcelFile(null);
      setError(null);
    }
  };

  const handleScreenshotsUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setScreenshots(prev => [...prev, ...Array.from(e.target.files!)]);
      setError(null);
    }
  };

  const runAnalysis = async () => {
    const hasSource = sourceMode === 'excel' ? !!excelFile : !!officialImage;
    if (!hasSource || screenshots.length === 0) {
      setError("يرجى التأكد من رفع كشف الأسماء الرسمي ولقطات زووم أولاً.");
      return;
    }

    setLoading(true);
    setError(null);
    setProgressLog([]);
    try {
      let officialNames: string[] = [];

      if (sourceMode === 'excel' && excelFile) {
        setProgressLog(["➜ جاري قراءة ملف الإكسيل..."]);
        officialNames = await extractNamesFromExcel(excelFile);
      } else if (sourceMode === 'image' && officialImage) {
        setProgressLog(["➜ جاري استخراج الأسماء من صورة الكشف..."]);
        const b64 = await fileToBase64(officialImage);
        officialNames = await extractNamesFromImage(b64, true);
        setProgressLog([`➜ تم استخراج ${officialNames.length} اسم من الكشف بنجاح.`]);
      }

      if (!officialNames || officialNames.length === 0) {
        throw new Error("لم نتمكن من العثور على أي أسماء. يرجى التأكد من جودة الملف أو الصورة.");
      }

      const zoomImagesB64 = await Promise.all(screenshots.map(fileToBase64));
      
      const res = await processAttendance(officialNames, zoomImagesB64, sensitivity, (msg) => {
        setProgressLog(prev => [...prev, `➜ ${msg}`]);
      });

      const sortFn = (list: Attendee[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
      
      setRawResults({
        present: sortFn(res.present),
        absent: sortFn(res.absent),
        unexpected: sortFn(res.unexpected),
      });
      setIsReviewing(true);
    } catch (err: any) {
      console.error("Analysis Error:", err);
      setError(err.message || "حدث خطأ غير متوقع. تأكد من اتصال الإنترنت وصلاحية مفتاح API.");
    } finally {
      setLoading(false);
    }
  };

  const rejectMatch = (index: number) => {
    if (!rawResults) return;
    const match = rawResults.present[index];
    const newPresent = rawResults.present.filter((_, i) => i !== index);
    const sortFn = (list: Attendee[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    setRawResults({
      ...rawResults,
      present: newPresent,
      absent: sortFn([...rawResults.absent, { name: match.name, status: AttendanceStatus.ABSENT }]),
      unexpected: sortFn([...rawResults.unexpected, { name: match.originalName || "", status: AttendanceStatus.UNEXPECTED }])
    });
  };

  const finalizeReport = () => {
    if (!rawResults) return;
    setFinalResults(rawResults);
    setIsReviewing(false);
  };

  const filteredDisplay = useMemo(() => {
    if (!finalResults) return null;
    const term = searchTerm.toLowerCase();
    const filterFn = (a: Attendee) => 
      a.name.toLowerCase().includes(term) || 
      (a.originalName?.toLowerCase().includes(term));
      
    return {
      present: finalResults.present.filter(filterFn),
      absent: finalResults.absent.filter(filterFn),
      unexpected: finalResults.unexpected.filter(filterFn)
    };
  }, [finalResults, searchTerm]);

  const toggleSelection = (name: string) => {
    const next = new Set(selectedNames);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedNames(next);
  };

  const initiateBulkChange = (status: AttendanceStatus) => {
    setPendingStatus(status);
    setShowBulkConfirm(true);
  };

  const handleBulkStatusChange = () => {
    if (!finalResults || !pendingStatus) return;
    
    const all = [...finalResults.present, ...finalResults.absent, ...finalResults.unexpected];
    const moved = all.filter(a => selectedNames.has(a.name));
    const remaining = all.filter(a => !selectedNames.has(a.name));

    const nextResults: ProcessingResult = { present: [], absent: [], unexpected: [] };
    const sortFn = (list: Attendee[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    [...remaining, ...moved.map(m => ({ ...m, status: pendingStatus }))].forEach(a => {
      if (a.status === AttendanceStatus.PRESENT) nextResults.present.push(a);
      else if (a.status === AttendanceStatus.ABSENT) nextResults.absent.push(a);
      else nextResults.unexpected.push(a);
    });

    setFinalResults({
      present: sortFn(nextResults.present),
      absent: sortFn(nextResults.absent),
      unexpected: sortFn(nextResults.unexpected)
    });
    setSelectedNames(new Set());
    setShowBulkConfirm(false);
    setPendingStatus(null);
  };

  const exportExcel = () => {
    if (!finalResults) return;
    const data = [
      ["الاسم", "الحالة", "الاسم الأصلي في زووم"],
      ...finalResults.present.map(p => [p.name, "حاضر", p.originalName || ""]),
      ...finalResults.absent.map(a => [a.name, "غائب", ""]),
      ...finalResults.unexpected.map(u => [u.name, "خارج الكشف", ""])
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendance Report");
    XLSX.writeFile(wb, `United_Attendance_${new Date().toLocaleDateString('ar-EG')}.xlsx`);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#fcfdfe] text-slate-900 pb-24 relative">
      <div className="no-print">
        <Header />
      </div>
      
      <main className="flex-1 max-w-6xl mx-auto w-full p-6 space-y-12">
        {!rawResults && !finalResults ? (
          <div className="space-y-12 py-10 no-print animate-in fade-in slide-in-from-bottom-10 duration-700">
            <div className="text-center space-y-4">
              <h2 className="text-5xl font-black tracking-tight text-slate-800">تحليل الحضور والغياب الذكي</h2>
              <p className="text-lg text-slate-500 max-w-2xl mx-auto leading-relaxed">
                ارفع كشف الأسماء بأي صيغة (Excel أو صورة) ودع الذكاء الاصطناعي يطابقهم مع حضور الزووم.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-10">
              <div className="bg-white border border-slate-200 p-8 rounded-[2.5rem] shadow-sm space-y-8">
                <div className="flex items-center justify-between">
                  <h3 className="text-2xl font-black">1. كشف الأسماء الرسمي</h3>
                  <div className="flex bg-slate-100 p-1.5 rounded-2xl">
                    <button 
                      onClick={() => setSourceMode('excel')}
                      className={`px-5 py-2.5 rounded-xl text-sm font-black transition-all ${sourceMode === 'excel' ? 'bg-white shadow-sm text-emerald-600' : 'text-slate-400'}`}
                    >إكسيل</button>
                    <button 
                      onClick={() => setSourceMode('image')}
                      className={`px-5 py-2.5 rounded-xl text-sm font-black transition-all ${sourceMode === 'image' ? 'bg-white shadow-sm text-emerald-600' : 'text-slate-400'}`}
                    >صورة</button>
                  </div>
                </div>

                <div className="relative group">
                  <div className="absolute -inset-1 bg-emerald-500/10 rounded-[2rem] blur opacity-0 group-hover:opacity-100 transition duration-500"></div>
                  <label className="relative block border-2 border-dashed border-slate-200 hover:border-emerald-400 bg-slate-50/50 p-12 rounded-[2rem] cursor-pointer text-center transition-all">
                    <input 
                      type="file" 
                      accept={sourceMode === 'excel' ? ".xlsx,.xls" : "image/*"} 
                      onChange={sourceMode === 'excel' ? handleExcelUpload : handleOfficialImageUpload}
                      className="hidden" 
                    />
                    <div className="flex flex-col items-center gap-5">
                      <div className="w-20 h-20 bg-white rounded-3xl shadow-sm flex items-center justify-center text-emerald-600 group-hover:scale-110 transition-transform duration-300">
                        {sourceMode === 'excel' ? (
                          <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        ) : (
                          <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        )}
                      </div>
                      <div className="space-y-1">
                        <div className="font-black text-slate-800 text-lg">{sourceMode === 'excel' ? "اختر ملف إكسيل" : "ارفع صورة الكشف"}</div>
                        <p className="text-sm text-slate-400 font-medium">{sourceMode === 'excel' ? "سيتم البحث عن عمود الأسماء تلقائياً" : "تأكد من وضوح الأسماء في الصورة"}</p>
                      </div>
                      {(excelFile || officialImage) && (
                        <div className="bg-emerald-600 text-white px-6 py-2.5 rounded-2xl text-xs font-black animate-in fade-in zoom-in shadow-md">
                          {sourceMode === 'excel' ? excelFile?.name : officialImage?.name}
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </div>

              <div className="bg-white border border-slate-200 p-8 rounded-[2.5rem] shadow-sm space-y-8">
                <h3 className="text-2xl font-black">2. لقطات حضور زووم</h3>
                <label className="relative block border-2 border-dashed border-slate-200 hover:border-blue-400 bg-slate-50/50 p-12 rounded-[2rem] cursor-pointer text-center transition-all group">
                  <input type="file" multiple accept="image/*" onChange={handleScreenshotsUpload} className="hidden" />
                  <div className="flex flex-col items-center gap-5">
                    <div className="w-20 h-20 bg-white rounded-3xl shadow-sm flex items-center justify-center text-blue-600 group-hover:scale-110 transition-transform duration-300">
                      <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    </div>
                    <div className="space-y-1">
                      <div className="font-black text-slate-800 text-lg">ارفع صور المشاركين</div>
                      <p className="text-sm text-slate-400 font-medium">يمكنك اختيار عدة صور معاً</p>
                    </div>
                    {screenshots.length > 0 && (
                      <div className="bg-blue-600 text-white px-6 py-2.5 rounded-2xl text-xs font-black animate-in fade-in shadow-md">
                        تم اختيار {screenshots.length} صور
                      </div>
                    )}
                  </div>
                </label>
              </div>
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-200 text-rose-600 p-6 rounded-[2rem] text-center font-black animate-in zoom-in shadow-sm flex items-center justify-center gap-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                {error}
              </div>
            )}

            <button
              onClick={runAnalysis}
              disabled={loading}
              className={`group relative w-full py-7 rounded-[2.5rem] font-black text-white text-2xl transition-all shadow-2xl overflow-hidden ${
                loading ? 'bg-slate-400 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700 active:scale-95'
              }`}
            >
              {loading ? (
                <div className="flex items-center justify-center gap-4">
                  <div className="w-7 h-7 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
                  <span>جاري معالجة البيانات...</span>
                </div>
              ) : "بدء مطابقة الحضور الذكي"}
            </button>

            {loading && (
              <div className="bg-slate-900 text-emerald-400 p-8 rounded-[2rem] font-mono text-xs max-h-64 overflow-y-auto space-y-2 shadow-2xl border border-slate-800 animate-in fade-in duration-500 scroll-smooth">
                {progressLog.map((log, i) => <div key={i} className="flex gap-3 opacity-90"><span className="text-emerald-500/50">[{new Date().toLocaleTimeString('ar-EG')}]</span> {log}</div>)}
              </div>
            )}
          </div>
        ) : isReviewing && rawResults ? (
          <div className="space-y-8 animate-in slide-in-from-right duration-700">
            <div className="bg-white p-10 rounded-[2.5rem] border border-slate-200 shadow-sm flex flex-col md:flex-row items-center md:items-end justify-between gap-6">
              <div className="space-y-2 text-center md:text-right">
                <h2 className="text-4xl font-black text-slate-800">مراجعة المطابقات</h2>
                <p className="text-slate-400 font-medium text-lg">تأكد من دقة مطابقة الأسماء بين الكشف وزووم</p>
              </div>
              <button onClick={finalizeReport} className="w-full md:w-auto px-12 py-5 bg-emerald-600 text-white rounded-[1.5rem] font-black hover:bg-emerald-700 shadow-xl transition-all hover:-translate-y-1">اعتماد واستخراج التقرير</button>
            </div>
            <div className="bg-white rounded-[2.5rem] shadow-xl border border-slate-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-right">
                  <thead className="bg-slate-50 text-slate-500 text-xs font-black uppercase tracking-widest border-b border-slate-100">
                    <tr>
                      <th className="p-8">الاسم الرسمي في الكشف</th>
                      <th className="p-8">الاسم المكتشف في زووم</th>
                      <th className="p-8 text-center">إلغاء المطابقة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {rawResults.present.map((p, i) => (
                      <tr key={i} className="hover:bg-emerald-50/40 transition-colors group">
                        <td className="p-8 font-black text-slate-800 text-xl">{p.name}</td>
                        <td className="p-8 text-emerald-700 font-bold text-lg">{p.originalName}</td>
                        <td className="p-8 text-center">
                          <button onClick={() => rejectMatch(i)} className="p-4 bg-rose-50 text-rose-500 rounded-2xl hover:bg-rose-500 hover:text-white transition-all shadow-sm group-hover:scale-110">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : finalResults && filteredDisplay ? (
          <div className="space-y-12 animate-in fade-in duration-1000">
            {/* إحصائيات التقرير */}
            <div className="grid md:grid-cols-4 gap-8 no-print">
              <div className="md:col-span-2 bg-white p-12 rounded-[3rem] border border-slate-200 shadow-sm flex flex-col justify-between">
                <div className="space-y-3">
                  <h2 className="text-5xl font-black text-slate-800 tracking-tight">النتائج النهائية</h2>
                  <p className="text-slate-400 font-bold text-xl">تم الانتهاء من فحص {finalResults.present.length + finalResults.absent.length} صيدلي.</p>
                </div>
                <div className="flex gap-4 mt-10">
                   <button onClick={exportExcel} className="flex-1 py-5 bg-emerald-600 text-white rounded-[1.5rem] font-black hover:bg-emerald-700 shadow-lg transition-all flex items-center justify-center gap-3">
                     <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                     Excel
                   </button>
                   <button onClick={() => window.print()} className="flex-1 py-5 bg-white border-2 border-slate-100 text-slate-700 rounded-[1.5rem] font-black hover:bg-slate-50 transition-all flex items-center justify-center gap-3">
                     <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                     طباعة
                   </button>
                </div>
              </div>
              <div className="bg-emerald-600 p-10 rounded-[3rem] shadow-2xl text-white space-y-4 flex flex-col justify-center">
                <span className="text-xs font-black uppercase tracking-[0.2em] opacity-70">حاضرون (Matched)</span>
                <div className="text-8xl font-black">{filteredDisplay.present.length}</div>
              </div>
              <div className="bg-rose-500 p-10 rounded-[3rem] shadow-2xl text-white space-y-4 flex flex-col justify-center">
                <span className="text-xs font-black uppercase tracking-[0.2em] opacity-70">غائبون (Not Seen)</span>
                <div className="text-8xl font-black">{filteredDisplay.absent.length}</div>
              </div>
            </div>

            {/* قوائم الأسماء */}
            <div className="grid md:grid-cols-3 gap-10 min-h-[600px]">
               <div className="flex flex-col space-y-6">
                  <div className="bg-emerald-600/10 border-2 border-emerald-600/20 p-6 rounded-[2rem] text-emerald-700 font-black text-center text-xl">الحاضرون</div>
                  <div className="flex-1 bg-white border border-slate-200 rounded-[2.5rem] p-6 space-y-3 overflow-y-auto max-h-[600px] shadow-sm">
                    {filteredDisplay.present.map((p, i) => (
                      <div key={i} className={`p-5 rounded-2xl border transition-all flex items-center gap-4 ${selectedNames.has(p.name) ? 'bg-emerald-50 border-emerald-500 shadow-md translate-x-1' : 'bg-slate-50/50 border-slate-100'}`}>
                        <input type="checkbox" className="no-print w-6 h-6 rounded-lg text-emerald-600" checked={selectedNames.has(p.name)} onChange={() => toggleSelection(p.name)} />
                        <div className="font-black text-slate-800 text-lg">{p.name}</div>
                      </div>
                    ))}
                  </div>
               </div>

               <div className="flex flex-col space-y-6">
                  <div className="bg-rose-500/10 border-2 border-rose-500/20 p-6 rounded-[2rem] text-rose-700 font-black text-center text-xl">الغائبون</div>
                  <div className="flex-1 bg-white border border-slate-200 rounded-[2.5rem] p-6 space-y-3 overflow-y-auto max-h-[600px] shadow-sm">
                    {filteredDisplay.absent.map((a, i) => (
                      <div key={i} className={`p-5 rounded-2xl border transition-all flex items-center gap-4 ${selectedNames.has(a.name) ? 'bg-rose-50 border-rose-500 shadow-md translate-x-1' : 'bg-white border-slate-100'}`}>
                        <input type="checkbox" className="no-print w-6 h-6 rounded-lg text-rose-600" checked={selectedNames.has(a.name)} onChange={() => toggleSelection(a.name)} />
                        <div className="font-bold text-slate-700 text-lg">{a.name}</div>
                      </div>
                    ))}
                  </div>
               </div>

               <div className="flex flex-col space-y-6">
                  <div className="bg-amber-500/10 border-2 border-amber-500/20 p-6 rounded-[2rem] text-amber-700 font-black text-center text-xl">خارج الكشف</div>
                  <div className="flex-1 bg-white border border-slate-200 rounded-[2.5rem] p-6 space-y-3 overflow-y-auto max-h-[600px] shadow-sm">
                    {filteredDisplay.unexpected.map((u, i) => (
                      <div key={i} className={`p-5 rounded-2xl border transition-all flex items-center gap-4 ${selectedNames.has(u.name) ? 'bg-amber-50 border-amber-500 shadow-md translate-x-1' : 'bg-slate-50/50 border-slate-100'}`}>
                        <input type="checkbox" className="no-print w-6 h-6 rounded-lg text-amber-600" checked={selectedNames.has(u.name)} onChange={() => toggleSelection(u.name)} />
                        <div className="font-bold text-slate-600 text-lg">{u.name}</div>
                      </div>
                    ))}
                  </div>
               </div>
            </div>

            {selectedNames.size > 0 && (
              <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-40 no-print animate-in slide-in-from-bottom-20 duration-500">
                <div className="bg-slate-900/90 backdrop-blur-3xl text-white px-12 py-8 rounded-[3rem] shadow-[0_35px_60px_-15px_rgba(0,0,0,0.5)] border border-white/10 flex items-center gap-12">
                  <div className="flex items-center gap-5">
                    <div className="w-14 h-14 bg-emerald-500 text-slate-900 rounded-2xl flex items-center justify-center font-black text-2xl shadow-inner">{selectedNames.size}</div>
                    <span className="font-black text-xl">صيدلي مختار</span>
                  </div>
                  <div className="flex gap-5">
                    <button onClick={() => initiateBulkChange(AttendanceStatus.PRESENT)} className="px-10 py-4 bg-emerald-600 rounded-2xl font-black text-lg hover:bg-emerald-500 transition-colors shadow-lg">نقل للحاضرين</button>
                    <button onClick={() => initiateBulkChange(AttendanceStatus.ABSENT)} className="px-10 py-4 bg-rose-600 rounded-2xl font-black text-lg hover:bg-rose-500 transition-colors shadow-lg">نقل للغائبين</button>
                  </div>
                  <button onClick={() => setSelectedNames(new Set())} className="text-slate-400 hover:text-white font-bold transition-colors">إلغاء التحديد</button>
                </div>
              </div>
            )}
            
            <button 
              onClick={resetApp} 
              className="w-full py-10 border-4 border-dashed border-slate-200 rounded-[3rem] text-slate-300 font-black text-2xl hover:bg-slate-50 hover:text-slate-400 hover:border-slate-300 transition-all no-print flex flex-col items-center gap-2"
            >
              <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              بدء تحليل جديد بالكامل
            </button>
          </div>
        ) : null}
      </main>

      {showBulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300">
          <div className="bg-white rounded-[3rem] shadow-2xl p-12 max-w-lg w-full space-y-10 animate-in zoom-in duration-300">
            <div className="text-center space-y-4">
               <div className="w-20 h-20 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
                 <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2l4-4" /></svg>
               </div>
               <h3 className="text-3xl font-black text-slate-800">تأكيد تعديل الحالة</h3>
               <p className="text-slate-500 text-lg font-medium leading-relaxed">أنت الآن تقوم بتغيير حالة <span className="text-emerald-600 font-black">{selectedNames.size} صيدلي</span> إلى <span className="font-black text-slate-800">"{getStatusLabel(pendingStatus)}"</span>. هل تريد الاستمرار؟</p>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <button onClick={() => setShowBulkConfirm(false)} className="py-5 border-2 border-slate-100 rounded-[1.5rem] font-black text-slate-400 hover:bg-slate-50 transition-all">تراجع</button>
              <button onClick={handleBulkStatusChange} className="py-5 bg-emerald-600 text-white rounded-[1.5rem] font-black shadow-xl hover:bg-emerald-700 transition-all">نعم، تأكيد</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
