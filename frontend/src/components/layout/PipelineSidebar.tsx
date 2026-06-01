"use client";

import { motion } from "framer-motion";
import {
    ChevronRight,
    ChevronLeft,
    Terminal
} from "lucide-react";
import clsx from "clsx";
import { useTranslations } from "next-intl";
import { useLogStore } from "@/store/logStore";
import LumenXBranding from "./LumenXBranding";
import type { BreadcrumbSegment } from "./BreadcrumbBar";

interface Step {
    id: string;
    label: string;
    icon: any;
    comingSoon?: boolean;
}

interface PipelineSidebarProps {
    activeStep: string;
    onStepChange: (stepId: string) => void;
    steps: Step[];
    breadcrumbSegments?: BreadcrumbSegment[];
    headerActions?: React.ReactNode;
    /** Optional content rendered between the header and the steps
     *  nav. Used for the EpisodeMiniList when the current project
     *  belongs to a series, so users can switch episodes without
     *  leaving the pipeline shell. */
    topSlot?: React.ReactNode;
}

export default function PipelineSidebar({ activeStep, onStepChange, steps, breadcrumbSegments, headerActions, topSlot }: PipelineSidebarProps) {
    const tc = useTranslations("common");
    const tp = useTranslations("pipeline");
    const handleBack = () => {
        if (!breadcrumbSegments) return;
        if (breadcrumbSegments.length >= 2 && breadcrumbSegments[breadcrumbSegments.length - 2].hash) {
            window.location.hash = breadcrumbSegments[breadcrumbSegments.length - 2].hash!;
        } else if (breadcrumbSegments[0]?.hash) {
            window.location.hash = breadcrumbSegments[0].hash;
        } else {
            window.location.hash = "";
        }
    };

    return (
        <motion.aside
            initial={{ x: -100, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="w-64 flex-1 min-h-0 border-r border-glass-border bg-surface backdrop-blur-xl flex flex-col z-50"
        >
            {/* Header: breadcrumb navigation or branding */}
            <div className="p-5 border-b border-glass-border">
                {breadcrumbSegments ? (
                    <div className="space-y-3">
                        {/* Breadcrumb row */}
                        <div className="flex items-center gap-1.5">
                            <button
                                onClick={handleBack}
                                className="flex-shrink-0 text-text-secondary hover:text-foreground transition-colors"
                                title={tc("back")}
                            >
                                <ChevronLeft size={16} />
                            </button>
                            <nav className="flex items-center gap-1 text-xs min-w-0 flex-1">
                                {breadcrumbSegments.map((seg, i) => {
                                    const isLast = i === breadcrumbSegments.length - 1;
                                    return (
                                        <span key={i} className="flex items-center gap-1 min-w-0">
                                            {i > 0 && <span className="text-text-muted flex-shrink-0">&rsaquo;</span>}
                                            {seg.hash && !isLast ? (
                                                <a
                                                    href={seg.hash}
                                                    className="text-text-muted hover:text-foreground transition-colors truncate"
                                                >
                                                    {seg.label}
                                                </a>
                                            ) : (
                                                <span className={clsx(
                                                    "truncate",
                                                    isLast ? "text-foreground font-medium" : "text-text-muted"
                                                )}>
                                                    {seg.label}
                                                </span>
                                            )}
                                        </span>
                                    );
                                })}
                            </nav>
                        </div>
                        {/* Actions row */}
                        {headerActions && (
                            <div className="flex items-center gap-1">
                                {headerActions}
                            </div>
                        )}
                    </div>
                ) : (
                    <LumenXBranding size="sm" />
                )}
            </div>

            {topSlot}
            <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
                {steps.map((step, index) => {
                    const isActive = activeStep === step.id;
                    const Icon = step.icon;

                    return (
                        <button
                            key={step.id}
                            onClick={() => onStepChange(step.id)}
                            className={clsx(
                                "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 group relative overflow-hidden",
                                isActive
                                    ? "bg-primary/10 text-primary border border-primary/20"
                                    : "text-text-secondary hover:text-foreground hover:bg-glass"
                            )}
                        >
                            {isActive && (
                                <motion.div
                                    layoutId="active-pill"
                                    className="absolute left-0 w-1 h-full bg-primary"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                />
                            )}

                            <Icon size={20} className={clsx(
                                "transition-colors",
                                step.comingSoon ? "opacity-50" : "",
                                isActive ? "text-primary" : "group-hover:text-foreground"
                            )} />

                            <div className="flex flex-col items-start text-sm flex-1">
                                <div className="flex items-center gap-2">
                                    <span className={clsx("font-medium", step.comingSoon && "opacity-70")}>{step.label}</span>
                                    {step.comingSoon && (
                                        <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 font-medium">
                                            {tp("beta")}
                                        </span>
                                    )}
                                </div>
                                <span className="text-[10px] opacity-50 font-mono">{tp("stepIndex", { number: index + 1 })}</span>
                            </div>

                            {isActive && (
                                <ChevronRight size={16} className="ml-auto opacity-50" />
                            )}
                        </button>
                    );
                })}
            </nav>

            {/* Log toggle */}
            <div className="px-4 pb-1">
                <button
                    onClick={useLogStore.getState().toggleLogs}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-text-muted hover:text-purple-400 hover:bg-purple-500/10 transition-colors"
                >
                    <Terminal size={14} />
                    Request Log
                </button>
            </div>

            <div className="p-4 border-t border-glass-border">
                <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-glass border border-border-subtle">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary to-accent" />
                    <div className="flex flex-col">
                        <span className="text-sm font-medium text-foreground">Project Alpha</span>
                        <span className="text-xs text-text-muted">v0.1.0</span>
                    </div>
                </div>
            </div>
        </motion.aside>
    );
}
