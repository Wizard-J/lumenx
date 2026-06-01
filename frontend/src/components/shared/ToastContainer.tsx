"use client";
/**
 * ToastContainer — bottom-right stack of project-aware notifications.
 * Mounted once at the app root (Providers.tsx) so toasts survive
 * page/project navigation.
 */
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, Loader2, X } from "lucide-react";
import { useToastStore, type Toast, type ToastKind } from "@/store/toastStore";

const KIND_STYLES: Record<ToastKind, { ring: string; bg: string; icon: JSX.Element; iconClass: string }> = {
    info: {
        ring: "border-primary/40",
        bg: "bg-primary/10",
        icon: <Info size={14} />,
        iconClass: "text-primary",
    },
    progress: {
        ring: "border-primary/40",
        bg: "bg-primary/10",
        icon: <Loader2 size={14} className="animate-spin" />,
        iconClass: "text-primary",
    },
    success: {
        ring: "border-green-500/40",
        bg: "bg-green-500/10",
        icon: <CheckCircle2 size={14} />,
        iconClass: "text-green-400",
    },
    error: {
        ring: "border-red-500/40",
        bg: "bg-red-500/10",
        icon: <AlertCircle size={14} />,
        iconClass: "text-red-400",
    },
    warning: {
        ring: "border-amber-400/40",
        bg: "bg-amber-400/10",
        icon: <AlertTriangle size={14} />,
        iconClass: "text-amber-300",
    },
};

function ToastCard({ toast }: { toast: Toast }) {
    const dismiss = useToastStore((s) => s.dismiss);
    const style = KIND_STYLES[toast.kind];
    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={`pointer-events-auto w-[340px] rounded-lg border ${style.ring} ${style.bg} backdrop-blur-sm shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] px-3 py-2.5 flex items-start gap-2.5`}
        >
            <span className={`mt-0.5 shrink-0 ${style.iconClass}`}>{style.icon}</span>
            <div className="min-w-0 flex-1">
                {toast.projectTitle && (
                    <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-text-muted mb-0.5 truncate">
                        {toast.projectTitle}
                    </p>
                )}
                <p className="text-[13px] font-medium text-foreground leading-snug">{toast.title}</p>
                {toast.body && (
                    <p className="text-[11.5px] text-text-secondary mt-0.5 leading-snug">{toast.body}</p>
                )}
                {toast.action && (
                    <button
                        onClick={() => {
                            toast.action!.onClick();
                            dismiss(toast.id);
                        }}
                        className="mt-1.5 inline-flex items-center px-2 py-0.5 rounded-md bg-foreground/5 border border-glass-border text-[11px] font-medium text-foreground hover:bg-foreground/10 transition-colors"
                    >
                        {toast.action.label}
                    </button>
                )}
            </div>
            <button
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss"
                className="shrink-0 -mr-1 p-1 rounded text-text-muted hover:text-foreground transition-colors"
            >
                <X size={12} />
            </button>
        </motion.div>
    );
}

export default function ToastContainer() {
    const toasts = useToastStore((s) => s.toasts);
    return (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex flex-col-reverse gap-2 max-h-screen overflow-hidden">
            <AnimatePresence initial={false}>
                {toasts.map((t) => (
                    <ToastCard key={t.id} toast={t} />
                ))}
            </AnimatePresence>
        </div>
    );
}
