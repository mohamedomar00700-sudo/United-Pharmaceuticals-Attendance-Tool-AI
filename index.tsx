
import React, { useState, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from 'xlsx';

// --- 1. TYPES & ENUMS ---
enum AttendanceStatus {
  PRESENT = 'PRESENT',
  ABSENT = 'ABSENT',
  UNEXPECTED = 'UNEXPECTED'
}

enum MatchSensitivity {
  STRICT = 'STRICT',
  BALANCED = 'BALANCED',
  FLEXIBLE = 'FLEXIBLE'
}

interface Attendee {
  name: string;
  status: AttendanceStatus;
  originalName?: string;
}

interface ProcessingResult {
  present: Attendee[];
  absent: Attendee[];
  unexpected: Attendee[];
}

// --- 2. SERVICES (Gemini & Excel) ---
const getAIClient = () => new GoogleGenAI({ apiKey: process.env.API_KEY });
const MODEL_NAME = "gemini-3-flash-preview";

const extractNamesFromExcel = async (file: File): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        
        let names: string[] = [];
        jsonData.forEach(row => {
          row.forEach(cell => {
            const val = cell?.toString().trim();
            // تصفية: الاسم يجب أن يكون أكثر من 5 حروف وكلمتين على الأقل وليس رقماً
            if (val && val.length > 5 && val.split(' ').length >= 2 && isNaN(Number(val))) {
              names.push(val);
            }
          });
        });
        resolve(Array.from(new Set(names)));
      } catch (err) { reject(err); }
    };
    reader.readAsArrayBuffer(file);
  });
};

const extractNamesFromImage = async (base64Data: string, isOfficial: boolean = false): Promise<string[]> => {
  try {
    const ai = getAIClient();
    const imageData = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const prompt = isOfficial 
      ? "استخرج جميع الأسماء الكاملة من هذه القائمة الرسمية. تجاهل الأرقام والعناوين. الأسماء فقط." 
      : "Extract all participant names from this Zoom screen. Ignore status tags like (Host) or (Me).";
    
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: { parts: [{ inlineData: { data: imageData, mimeType: "image/png" } }, { text: prompt }] }
    });
    return (response.text || "").split("\n").map(n => n.trim()).filter(n => n.length > 2);
  } catch (e) { 
    console.error("AI Error:", e);
    return []; 
  }
};

const processAttendance = async (official: string[], screenshots: string[], onProgress: (m: string) => void): Promise<ProcessingResult> => {
  const ai = getAIClient();
  const zoomNames = new Set<string>();
  
  for (let i = 0; i < screenshots.length; i++) {
    onProgress(`جاري فحص لقطة زووم رقم ${i + 1}...`);
    const names = await extractNamesFromImage(screenshots[i]);
    names.forEach(n => zoomNames.add(n));
  }

  onProgress(`جاري مطابقة الأسماء ذكياً ومراعاة اختلاف اللغة...`);
  const prompt = `
    Match Official List with Zoom List. 
    Official: [${official.join(", ")}]
    Zoom: [${Array.from(zoomNames).join(", ")}]
    Rule: Some names are in Arabic, others in English. Match them correctly.
    Return JSON format only.
  `;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          present: { 
            type: Type.ARRAY, 
            items: { 
              type: Type.OBJECT, 
              properties: { 
                name: { type: Type.STRING }, 
                originalName: { type: Type.STRING } 
              } 
            } 
          },
          absent: { type: Type.ARRAY, items: { type: Type.STRING } },
          unexpected: { type: Type.ARRAY, items: { type: Type.STRING } }
        }
      }
    }
  });

  const res = JSON.parse(response.text);
  return {
    present: res.present.map((p: any) => ({ ...p, status: AttendanceStatus.PRESENT })),
    absent: res.absent.map((name: string) => ({ name, status: AttendanceStatus.ABSENT })),
    unexpected: res.unexpected.map((name: string) => ({ name, status: AttendanceStatus.UNEXPECTED }))
  };
};

// --- 3. UI COMPONENTS ---
const Header: React.FC = () => (
  <header className="sticky top-0 z-40 w-full bg-white/90 backdrop-blur-md border-b border-slate-200 px-6 py-4 no-print">
    <div className="max-w-7xl mx-auto flex items-center justify-between">
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white font-black text-xl shadow-lg shadow-emerald-200">U</div>
        <div>
          <h1 className="text-xl font-black text-slate-800">صيدليات المتحدة <span className="text-emerald-600">|</span> الحضور الذكي</h1>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Attendance AI Intelligence System</p>
        </div>
      </div>
      <div className="hidden md:flex items-center gap-2 px-4 py-2 bg-emerald-50 rounded-full border border-emerald-100">
        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
        <span className="text-xs font-bold text-emerald-700">النظام نشط V2.2</span>
      </div>
    </div>
  </header>
);

const App: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [sourceMode, setSourceMode] = useState<'excel' | 'image'>('excel');
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [officialImage, setOfficialImage] = useState<File | null>(null);
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [progress, setProgress] = useState<string[]>([]);
  const [results, setResults] = useState<ProcessingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    if (confirm("هل تريد بدء تحليل جديد ومسح البيانات الحالية؟")) {
      setResults(null); setExcelFile(null); setOfficialImage(null); setScreenshots([]); setProgress([]); setError(null);
    }
  };

  const fileToB64 = (file: File): Promise<string> => new Promise(r => {
    const reader = new FileReader();
    reader.onload = () => r(reader.result as string);
    reader.readAsDataURL(file);
  });

  const startAnalysis = async () => {
    if ((sourceMode === 'excel' && !excelFile) || (sourceMode === 'image' && !officialImage) || screenshots.length === 0) {
      setError("يرجى رفع كشف الأسماء الرسمي ولقطة زووم واحدة على الأقل.");
      return;
    }
    setLoading(true); setProgress([]); setError(null);
    try {
      let official: string[] = [];
      if (sourceMode === 'excel' && excelFile) {
        setProgress(["جاري قراءة ملف الإكسيل..."]);
        official = await extractNamesFromExcel(excelFile);
      } else if (officialImage) {
        setProgress(["جاري تحليل صورة الكشف..."]);
        const b64 = await fileToB64(officialImage);
        official = await extractNamesFromImage(b64, true);
      }

      if (official.length === 0) throw new Error("لم نجد أسماء في الكشف الرسمي.");

      const screensB64 = await Promise.all(screenshots.map(fileToB64));
      const res = await processAttendance(official, screensB64, (m) => setProgress(prev => [...prev, m]));
      setResults(res);
    } catch (e: any) {
      setError(e.message || "حدث خطأ أثناء التحليل. تأكد من جودة الصور.");
    } finally {
      setLoading(false);
    }
  };

  const exportExcel = () => {
    if (!results) return;
    const data = [
      ["الاسم", "الحالة", "الاسم في زووم"],
      ...results.present.map(p => [p.name, "حاضر", p.originalName || ""]),
      ...results.absent.map(a => [a.name, "غائب", ""])
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendance Report");
    XLSX.writeFile(wb, `United_Attendance_${new Date().toLocaleDateString('ar-EG')}.xlsx`);
  };

  return (
    <div className="min-h-screen bg-[#fcfdfe] flex flex-col">
      <Header />
      <main className="flex-1 max-w-5xl mx-auto w-full p-6 space-y-8">
        {!results ? (
          <div className="space-y-10 py-10 no-print">
            <div className="text-center space-y-2">
              <h2 className="text-4xl font-black text-slate-800">مرحباً بك في نظام الحضور الذكي</h2>
              <p className="text-slate-400 font-medium">ارفع البيانات المطلوبة وسيتولى الذكاء الاصطناعي الباقي.</p>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
              <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-xl font-black">1. الكشف الرسمي</h3>
                  <div className="flex bg-slate-100 p-1 rounded-xl">
                    <button onClick={()=>setSourceMode('excel')} className={`px-4 py-2 rounded-lg text-xs font-bold ${sourceMode==='excel'?'bg-white shadow text-emerald-600':'text-slate-400'}`}>Excel</button>
                    <button onClick={()=>setSourceMode('image')} className={`px-4 py-2 rounded-lg text-xs font-bold ${sourceMode==='image'?'bg-white shadow text-emerald-600':'text-slate-400'}`}>Image</button>
                  </div>
                </div>
                <input type="file" onChange={e => sourceMode==='excel' ? setExcelFile(e.target.files![0]) : setOfficialImage(e.target.files![0])} className="w-full border-2 border-dashed border-slate-200 p-10 rounded-[2rem] text-sm file:hidden cursor-pointer hover:bg-slate-50 transition-all text-center" />
                {(excelFile || officialImage) && <div className="text-center text-emerald-600 font-black text-sm">✓ تم اختيار: {sourceMode==='excel' ? excelFile?.name : officialImage?.name}</div>}
              </div>

              <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-6">
                <h3 className="text-xl font-black">2. لقطات زووم</h3>
                <input type="file" multiple onChange={e => setScreenshots(Array.from(e.target.files!))} className="w-full border-2 border-dashed border-slate-200 p-10 rounded-[2rem] text-sm file:hidden cursor-pointer hover:bg-slate-50 transition-all text-center" />
                {screenshots.length > 0 && <div className="text-center text-blue-600 font-black text-sm">✓ تم اختيار {screenshots.length} صور</div>}
              </div>
            </div>

            {error && <div className="p-6 bg-rose-50 border border-rose-100 text-rose-600 rounded-3xl text-center font-black">{error}</div>}

            <button onClick={startAnalysis} disabled={loading} className="w-full py-6 bg-emerald-600 text-white rounded-[2rem] font-black text-xl hover:bg-emerald-700 shadow-2xl shadow-emerald-200 disabled:bg-slate-300 transition-all active:scale-95">
              {loading ? "جاري معالجة البيانات..." : "بدء المطابقة الآن"}
            </button>

            {loading && (
              <div className="bg-slate-900 text-emerald-400 p-6 rounded-[2rem] font-mono text-xs max-h-48 overflow-auto space-y-1 shadow-2xl">
                {progress.map((l,i)=><div key={i} className="flex gap-2"><span className="opacity-50">[{new Date().toLocaleTimeString()}]</span> {l}</div>)}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-10 animate-in fade-in duration-700">
            <div className="flex flex-col md:flex-row justify-between items-center bg-white p-10 rounded-[3rem] shadow-sm border border-slate-200 gap-6">
              <div className="text-center md:text-right space-y-1">
                <h2 className="text-3xl font-black text-slate-800">التقرير النهائي</h2>
                <p className="text-slate-400 font-bold">تم فحص {results.present.length + results.absent.length} صيدلي بنجاح.</p>
              </div>
              <div className="flex gap-4 w-full md:w-auto no-print">
                <button onClick={exportExcel} className="flex-1 md:px-10 py-4 bg-emerald-600 text-white rounded-2xl font-black hover:bg-emerald-700 shadow-lg">Excel</button>
                <button onClick={() => window.print()} className="flex-1 md:px-10 py-4 bg-white border border-slate-200 text-slate-600 rounded-2xl font-black">طباعة</button>
                <button onClick={reset} className="flex-1 md:px-10 py-4 bg-rose-50 text-rose-600 rounded-2xl font-black">إعادة</button>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-10">
              <div className="bg-white rounded-[2.5rem] p-8 border border-slate-200 shadow-sm flex flex-col h-[600px]">
                <div className="flex items-center justify-between mb-6">
                   <h4 className="font-black text-emerald-600 text-xl flex items-center gap-3">
                     <span className="w-8 h-8 bg-emerald-50 rounded-full flex items-center justify-center italic">✔</span> الحاضرون ({results.present.length})
                   </h4>
                </div>
                <div className="flex-1 overflow-auto space-y-3 pr-2">
                  {results.present.map((p,i)=>(
                    <div key={i} className="p-4 bg-emerald-50/50 border border-emerald-100 rounded-2xl">
                       <div className="font-black text-slate-800">{p.name}</div>
                       <div className="text-[10px] text-emerald-600 font-bold mt-1 opacity-60">مطابق لـ: {p.originalName}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white rounded-[2.5rem] p-8 border border-slate-200 shadow-sm flex flex-col h-[600px]">
                <div className="flex items-center justify-between mb-6">
                   <h4 className="font-black text-rose-600 text-xl flex items-center gap-3">
                     <span className="w-8 h-8 bg-rose-50 rounded-full flex items-center justify-center italic">✖</span> الغائبون ({results.absent.length})
                   </h4>
                </div>
                <div className="flex-1 overflow-auto space-y-3 pr-2">
                  {results.absent.map((a,i)=>(
                    <div key={i} className="p-4 bg-rose-50/50 border border-rose-100 rounded-2xl font-bold text-slate-700">
                      {a.name}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
      <footer className="py-8 text-center text-slate-300 text-[10px] font-bold uppercase tracking-widest no-print">
        Powered by Google Gemini AI & United Pharmacies IT
      </footer>
    </div>
  );
};

// --- 4. RENDER ---
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<App />);
}
