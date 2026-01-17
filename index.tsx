
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from 'xlsx';

// --- TYPES ---
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

// --- SERVICES ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const modelName = "gemini-3-flash-preview";

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
        // محاولة بسيطة لاستخراج العمود الذي يحتوي على أسماء (أكثر من كلمة، ليس رقماً)
        jsonData.forEach(row => {
          row.forEach(cell => {
            const val = cell?.toString().trim();
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
    const imageData = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const prompt = isOfficial ? "Extract all full names from this list. Arabic/English." : "Extract all names from this Zoom participant list.";
    const response = await ai.models.generateContent({
      model: modelName,
      contents: { parts: [{ inlineData: { data: imageData, mimeType: "image/png" } }, { text: prompt }] }
    });
    return (response.text || "").split("\n").map(n => n.trim()).filter(n => n.length > 2);
  } catch (e) { return []; }
};

const processAttendance = async (official: string[], screenshots: string[], sensitivity: MatchSensitivity, onProgress: (m: string) => void): Promise<ProcessingResult> => {
  const zoomNames = new Set<string>();
  for (let i = 0; i < screenshots.length; i++) {
    onProgress(`جاري فحص صورة زووم رقم ${i + 1}...`);
    const names = await extractNamesFromImage(screenshots[i]);
    names.forEach(n => zoomNames.add(n));
  }

  onProgress(`جاري مطابقة الأسماء ذكياً...`);
  const prompt = `Match official list with zoom list. Official: [${official.join(", ")}], Zoom: [${Array.from(zoomNames).join(", ")}]. Return JSON {present: [{name, originalName}], absent: [name], unexpected: [name]}`;
  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          present: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: {type: Type.STRING}, originalName: {type: Type.STRING} } } },
          absent: { type: Type.ARRAY, items: {type: Type.STRING} },
          unexpected: { type: Type.ARRAY, items: {type: Type.STRING} }
        }
      }
    }
  });

  const res = JSON.parse(response.text);
  return {
    present: res.present.map(p => ({ ...p, status: AttendanceStatus.PRESENT })),
    absent: res.absent.map(name => ({ name, status: AttendanceStatus.ABSENT })),
    unexpected: res.unexpected.map(name => ({ name, status: AttendanceStatus.UNEXPECTED }))
  };
};

// --- COMPONENTS ---
const Header: React.FC = () => (
  <header className="sticky top-0 z-40 w-full bg-white/80 backdrop-blur-md border-b border-slate-200 px-6 py-4">
    <div className="max-w-7xl mx-auto flex items-center justify-between">
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 bg-emerald-600 rounded-lg flex items-center justify-center text-white font-black">U</div>
        <div>
          <h1 className="text-lg font-black text-slate-800">صيدليات المتحدة | الحضور الذكي</h1>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Attendance AI V2.1</p>
        </div>
      </div>
      <div className="text-xs font-black text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">النظام نشط</div>
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
    if (confirm("بدء جديد؟")) {
      setResults(null); setExcelFile(null); setOfficialImage(null); setScreenshots([]); setProgress([]); setError(null);
    }
  };

  const start = async () => {
    setLoading(true); setProgress([]); setError(null);
    try {
      let official: string[] = [];
      if (sourceMode === 'excel' && excelFile) official = await extractNamesFromExcel(excelFile);
      else if (officialImage) {
        const b64 = await new Promise<string>(r => { const rd = new FileReader(); rd.onload = () => r(rd.result as string); rd.readAsDataURL(officialImage); });
        official = await extractNamesFromImage(b64, true);
      }

      const screensB64 = await Promise.all(screenshots.map(f => new Promise<string>(r => { const rd = new FileReader(); rd.onload = () => r(rd.result as string); rd.readAsDataURL(f); })));
      const res = await processAttendance(official, screensB64, MatchSensitivity.BALANCED, (m) => setProgress(p => [...p, m]));
      setResults(res);
    } catch (e) { setError("فشل التحليل. تأكد من الملفات."); }
    finally { setLoading(false); }
  };

  const exportExcel = () => {
    if (!results) return;
    const data = [["الاسم", "الحالة"], ...results.present.map(p => [p.name, "حاضر"]), ...results.absent.map(a => [a.name, "غائب"])];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendance");
    XLSX.writeFile(wb, "United_Attendance.xlsx");
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header />
      <main className="flex-1 max-w-5xl mx-auto w-full p-6 space-y-8">
        {!results ? (
          <div className="bg-white p-10 rounded-3xl shadow-sm border border-slate-200 space-y-10">
            <div className="grid md:grid-cols-2 gap-8">
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-black text-slate-700">1. الكشف الرسمي</h3>
                  <div className="flex bg-slate-100 p-1 rounded-lg text-xs">
                    <button onClick={()=>setSourceMode('excel')} className={`px-3 py-1 rounded ${sourceMode==='excel'?'bg-white shadow text-emerald-600':'text-slate-400'}`}>Excel</button>
                    <button onClick={()=>setSourceMode('image')} className={`px-3 py-1 rounded ${sourceMode==='image'?'bg-white shadow text-emerald-600':'text-slate-400'}`}>Image</button>
                  </div>
                </div>
                <input type="file" onChange={e => sourceMode==='excel'?setExcelFile(e.target.files![0]):setOfficialImage(e.target.files![0])} className="w-full border-2 border-dashed p-6 rounded-2xl text-sm" />
              </div>
              <div className="space-y-4">
                <h3 className="font-black text-slate-700">2. لقطات زووم</h3>
                <input type="file" multiple onChange={e => setScreenshots(Array.from(e.target.files!))} className="w-full border-2 border-dashed p-6 rounded-2xl text-sm" />
              </div>
            </div>
            {error && <div className="p-4 bg-rose-50 text-rose-600 rounded-xl text-center font-bold">{error}</div>}
            <button onClick={start} disabled={loading} className="w-full py-5 bg-emerald-600 text-white rounded-2xl font-black text-xl hover:bg-emerald-700 disabled:bg-slate-300">
              {loading ? "جاري المعالجة..." : "بدء التحليل الذكي"}
            </button>
            {loading && <div className="bg-slate-900 text-emerald-400 p-4 rounded-xl font-mono text-xs max-h-40 overflow-auto">{progress.map((l,i)=><div key={i}>➜ {l}</div>)}</div>}
          </div>
        ) : (
          <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex justify-between items-center bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
              <div className="space-y-1">
                <h2 className="text-2xl font-black text-slate-800">التقرير النهائي</h2>
                <p className="text-slate-400 text-sm font-bold">حاضر: {results.present.length} | غائب: {results.absent.length}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={exportExcel} className="px-6 py-3 bg-emerald-600 text-white rounded-xl font-black text-sm">Excel</button>
                <button onClick={reset} className="px-6 py-3 bg-slate-100 text-slate-500 rounded-xl font-black text-sm">إعادة</button>
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-8">
              <div className="bg-white rounded-3xl p-6 border border-slate-200 h-[500px] flex flex-col">
                <h4 className="font-black text-emerald-600 mb-4 flex items-center gap-2"><span>✔</span> حاضر ({results.present.length})</h4>
                <div className="flex-1 overflow-auto space-y-2">
                  {results.present.map((p,i)=><div key={i} className="p-3 bg-emerald-50 rounded-lg text-sm font-bold text-emerald-800">{p.name}</div>)}
                </div>
              </div>
              <div className="bg-white rounded-3xl p-6 border border-slate-200 h-[500px] flex flex-col">
                <h4 className="font-black text-rose-600 mb-4 flex items-center gap-2"><span>✖</span> غائب ({results.absent.length})</h4>
                <div className="flex-1 overflow-auto space-y-2">
                  {results.absent.map((a,i)=><div key={i} className="p-3 bg-rose-50 rounded-lg text-sm font-bold text-rose-800">{a.name}</div>)}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

// --- RENDER ---
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<App />);
