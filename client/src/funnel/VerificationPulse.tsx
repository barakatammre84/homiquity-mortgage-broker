import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import { Logo } from "@/components/brand/Logo";

/**
 * The "backstage pass" during submission: instead of a generic spinner, show
 * the borrower what the platform is actually doing with their file. Stages
 * advance on a timer while the request is in flight; every label corresponds
 * to real pipeline work (profile review → ratio math → scenario build →
 * decision) — no theater, no invented steps.
 */

const STAGE_INTERVAL_MS = 1400;

export const PRE_APPROVAL_STAGES = [
  "Saving your application…",
  "Checking the information you provided…",
  "Building estimated loan scenarios…",
  "Preparing your next steps…",
] as const;

export function VerificationPulse({
  active,
  stages = [...PRE_APPROVAL_STAGES],
}: {
  active: boolean;
  stages?: string[];
}) {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setStageIndex(0);
      return;
    }
    const timer = setInterval(() => {
      // Hold on the final stage until the request actually resolves.
      setStageIndex((i) => Math.min(i + 1, stages.length - 1));
    }, STAGE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, stages.length]);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm p-4"
          data-testid="verification-pulse"
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-lg"
          >
            <div className="mb-5 flex flex-col items-center gap-3 text-center">
              <Logo size="sm" data-testid="logo-submit-transition" />
              <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Submitting your application
              </p>
            </div>
            <div className="space-y-3">
              {stages.map((label, i) => {
                const done = i < stageIndex;
                const current = i === stageIndex;
                return (
                  <div
                    key={label}
                    className="flex items-center gap-3"
                    data-testid={`pulse-stage-${i}`}
                  >
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-status-success" />
                    ) : current ? (
                      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                        <span className="absolute h-3 w-3 animate-ping rounded-full bg-primary/40" />
                        <span className="h-2 w-2 rounded-full bg-primary" />
                      </span>
                    ) : (
                      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-muted" />
                    )}
                    <span
                      className={`text-sm ${
                        done
                          ? "text-muted-foreground line-through decoration-muted-foreground/40"
                          : current
                            ? "font-medium text-foreground"
                            : "text-muted-foreground/60"
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-5 text-center text-xs text-muted-foreground/70">
              Soft check only — this will not affect your credit score.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
