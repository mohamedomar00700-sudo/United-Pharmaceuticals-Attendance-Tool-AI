
import React from 'react';

const Header: React.FC = () => {
  return (
    <header className="sticky top-0 z-40 w-full backdrop-blur-md bg-white/70 border-b border-slate-200/60 px-6 py-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-emerald-600 to-teal-500 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative w-12 h-12 bg-white rounded-xl flex items-center justify-center shadow-sm border border-slate-100 font-bold text-2xl text-emerald-600">
              U
            </div>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-700">
                صيدليات المتحدة <span className="text-emerald-600">|</span> United Pharmacies
              </h1>
              <span className="bg-emerald-100 text-emerald-700 text-[10px] font-black px-2 py-0.5 rounded-full">V2.0 AI</span>
            </div>
            <p className="text-[11px] font-medium text-slate-400 uppercase tracking-widest">
              Smart Attendance Intelligence System
            </p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-2 px-4 py-2 bg-emerald-50 rounded-full border border-emerald-100">
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
          <span className="text-xs font-bold text-emerald-700">النظام نشط وجاهز</span>
        </div>
      </div>
    </header>
  );
};

export default Header;
