import type { AbsGenerationBinding } from './abs-generation-protocol';
import { absJson } from './abs-identity-map';
import { describeAbsDerivedOutputs } from './abs-derived-outputs';

type DerivedReport = ReturnType<typeof describeAbsDerivedOutputs>;

/** One completed repair observation, not a generated-file cache or write retry.
 * Durable source repair does not imply its optional artifacts were published. */
export class AbsRepairDerivedReports {
  private completed?: { token: string; binding: string; report: DerivedReport };

  remember(token: string, binding: AbsGenerationBinding, report: DerivedReport): void {
    this.completed = { token, binding: absJson(binding), report: this.copy(report) };
  }

  observe(token: string, binding: AbsGenerationBinding): DerivedReport {
    const previous = this.completed;
    if (previous?.token === token && previous.binding === absJson(binding)) return this.copy(previous.report);
    const error = 'The saved workspace repair is committed, but this host has no observation of its derived output publication. '
      + 'This does not prove publication failed or succeeded. Keep the repaired source and generate/build the current canvas before relying on C++ artifacts.';
    return { output: { published: false, code: 'PROJECT_DERIVED_OUTPUT_UNKNOWN', error }, warnings: [error] };
  }

  private copy(report: DerivedReport): DerivedReport {
    return { output: report.output && { ...report.output }, warnings: [...report.warnings] };
  }
}
