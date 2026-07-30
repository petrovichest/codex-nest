import type {
  Project,
  TranscriptionConfigResponse,
  TranscriptionProvider,
  TranscriptionTimingEstimate,
} from "@codexnest/protocol";

import { ThreadPage } from "./ThreadPage";

/**
 * The session workspace intentionally owns both `/new` and `/threads/:id`.
 * App keeps this component mounted while a pending session resolves so its
 * Composer—and every DOM/internal state detail inside it—survives URL replacement.
 */
export function NewSession({
  projects,
  transcriptionConfig = null,
  transcriptionProvider = null,
  onTranscriptionTimingEstimateChange,
  onOpenNavigation,
}: {
  projects: Project[];
  transcriptionConfig?: TranscriptionConfigResponse | null;
  transcriptionProvider?: TranscriptionProvider | null;
  onTranscriptionTimingEstimateChange?(estimate: TranscriptionTimingEstimate): void;
  onOpenNavigation(): void;
}) {
  return (
    <ThreadPage
      projects={projects}
      transcriptionConfig={transcriptionConfig}
      transcriptionProvider={transcriptionProvider}
      onTranscriptionTimingEstimateChange={onTranscriptionTimingEstimateChange}
      onOpenNavigation={onOpenNavigation}
    />
  );
}
