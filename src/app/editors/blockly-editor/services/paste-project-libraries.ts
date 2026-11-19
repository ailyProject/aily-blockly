import { isAilyLibraryPackageName } from '@shared/public-api';
import { readManagedLibraryEnvironment } from '../../../services/domains/project/project-managed-library-environment';
import {
  installMissingLibrariesManaged,
  type MissingLibraryInstall,
} from './missing-project-libraries';

import type { ProjectService } from '../../../services/domains/project/project.service';
import type { MissingLibInfo } from '../components/paste-install-dialog/paste-install-dialog.component';

/** Paste has a live Working document. Each Main environment request uses its
 * own existing Domain snapshot/lease and matching history scope. */
export async function installPasteLibrariesManaged(input: {
  project: string;
  libraries: readonly MissingLibInfo[];
  signal: AbortSignal;
  assertCurrent(): void;
  domain: Pick<
    ProjectService,
    'beginLibraryMutation' | 'finishLibraryMutation' | 'abortLibraryMutation'
  >;
  host: Parameters<typeof installMissingLibrariesManaged>[0]['host'];
  storage(): Promise<{ executor?: { hostPid?: number | null } }>;
  readLocalPackage(source: string): { name?: unknown };
  options: Record<string, unknown>;
  cancel(requestId: string): Promise<unknown>;
}): Promise<void> {
  input.assertCurrent();
  const plans: MissingLibraryInstall[] = [],
    npm: string[] = [];
  for (const library of input.libraries) {
    if (!isAilyLibraryPackageName(library.name))
      throw new Error('Clipboard library package identity is invalid.');
    if (library.localPath) {
      if (input.readLocalPackage(library.localPath)?.name !== library.name)
        throw new Error(`Selected source is not ${library.name}.`);
      plans.push({
        packages: [`${library.name}@file:./local-libraries/${library.name}`],
        localSource: {
          packageName: library.name,
          source: library.localPath,
          force: false,
        },
      });
    } else {
      const version = (library.version || '').trim();
      if (version.startsWith('file:'))
        throw new Error(
          `The original local source of ${library.name} must be identified before installation.`,
        );
      npm.push(version ? `${library.name}@${version}` : library.name);
    }
  }
  if (npm.length) plans.push({ packages: npm });
  for (const plan of plans) {
    input.assertCurrent();
    const capability = await input.host.capabilities();
    input.assertCurrent();
    // beginLibraryMutation can write history/environment metadata. An older
    // Main must be rejected before entering that existing Domain transaction.
    if (capability?.dependencyEnvironmentVersion !== 2)
      throw Object.assign(
        new Error(
          'Paste library installation requires the matching managed dependency publisher.',
        ),
        { code: 'LIBRARY_ENVIRONMENT_UNAVAILABLE' },
      );
    const storage = await input.storage();
    input.assertCurrent();
    const executorPid = storage?.executor?.hostPid;
    if (!Number.isSafeInteger(executorPid) || executorPid! <= 0)
      throw new Error('Paste library installation has no physical Main owner.');
    let token: string | undefined;
    try {
      ({ token } = await input.domain.beginLibraryMutation(plan.packages));
      input.assertCurrent();
      let reference:
        { requestId: string; originalTargetPid: number } | undefined;
      await installMissingLibrariesManaged({
        project: input.project,
        installs: [plan],
        host: input.host,
        signal: input.signal,
        assertCurrent: input.assertCurrent,
        options: input.options,
        cancel: input.cancel,
        verify: async (requestId, packages) => {
          const value = { requestId, originalTargetPid: executorPid! };
          await readManagedLibraryEnvironment(
            input.project,
            value,
            { packages, removedPackages: [] },
            input.assertCurrent,
          );
          input.assertCurrent();
          reference = value;
        },
      });
      input.assertCurrent();
      if (!reference)
        throw new Error(
          'The original paste library environment has no verified completion.',
        );
      await input.domain.finishLibraryMutation(
        token,
        false,
        reference,
        input.assertCurrent,
      );
      input.assertCurrent();
    } catch (error) {
      // Domain abort discards only its history token and releases the live
      // edit/lease; it does not restore any committed Main environment bytes.
      if (token) await input.domain.abortLibraryMutation(token);
      throw error;
    }
  }
}
