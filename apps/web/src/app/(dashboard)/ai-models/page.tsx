"use client";

import { useState } from "react";
import { BrainCircuit, Cpu } from "lucide-react";
import { AiPredictionsDashboard } from "../../../features/predictions/components/ai-predictions-dashboard";
import { ModelPerformanceDashboard } from "../../../features/model-performance/components/model-performance-dashboard";
import { Tabs } from "../../../components/ui/tabs";
import { Reveal } from "../../../components/ui/reveal";

export default function AiModelsPage() {
  const [activeTab, setActiveTab] = useState<string>("predictions");

  const tabs = [
    { id: "predictions", label: "AI Predictions", icon: <BrainCircuit className="size-4" /> },
    { id: "performance", label: "Model Performance", icon: <Cpu className="size-4" /> },
  ];

  return (
    <div className="flex h-full flex-col font-sans">
      <div className="px-6 py-4 shrink-0">
        <h1 className="text-2xl font-black text-white tracking-tight">AI Models & Intelligence</h1>
        <p className="mt-1 text-sm text-slate-400">
          View real-time predictions and evaluate the historical performance of AI models.
        </p>
        <div className="mt-4">
          <Tabs tabs={tabs} activeId={activeTab} onChange={setActiveTab} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6 custom-scrollbar">
        <Reveal key={activeTab}>
          {activeTab === "predictions" ? (
            <div className="h-full">
              <AiPredictionsDashboard />
            </div>
          ) : (
            <div className="h-full">
              <ModelPerformanceDashboard />
            </div>
          )}
        </Reveal>
      </div>
    </div>
  );
}
