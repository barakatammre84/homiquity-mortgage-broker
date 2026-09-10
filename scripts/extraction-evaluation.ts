import {
  loadExtractionEvaluationManifest,
  prepareExtractionEvaluation,
  runExtractionEvaluation,
} from "../server/services/extractionEvaluationRunner";

interface CliOptions {
  manifestPath?: string;
  outputDirectory?: string;
  resume: boolean;
  dryRun: boolean;
  printManifestSha: boolean;
  maxCases?: number;
}

function usage(): never {
  console.error(`Usage:
  pnpm benchmark:extraction:run --manifest <private-manifest.json> --print-manifest-sha
  pnpm benchmark:extraction:run --manifest <private-manifest.json> --dry-run
  pnpm benchmark:extraction:run --manifest <private-manifest.json> --output <private-directory> [--resume] [--max-cases N]`);
  process.exit(2);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    resume: false,
    dryRun: false,
    printManifestSha: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--manifest") options.manifestPath = args[++index];
    else if (arg === "--output") options.outputDirectory = args[++index];
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--print-manifest-sha") options.printManifestSha = true;
    else if (arg === "--max-cases") {
      const raw = args[++index];
      options.maxCases = raw ? Number(raw) : Number.NaN;
    } else usage();
  }
  if (!options.manifestPath) usage();
  if (
    options.printManifestSha &&
    (options.dryRun || options.outputDirectory || options.resume || options.maxCases !== undefined)
  ) usage();
  if (options.dryRun && (options.outputDirectory || options.resume || options.maxCases !== undefined)) {
    usage();
  }
  if (!options.printManifestSha && !options.dryRun && !options.outputDirectory) usage();
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.printManifestSha) {
    const loaded = await loadExtractionEvaluationManifest(options.manifestPath!);
    console.log(JSON.stringify({ manifestSha256: loaded.manifestSha256 }, null, 2));
    return;
  }
  if (options.dryRun) {
    const prepared = await prepareExtractionEvaluation(options.manifestPath!);
    const byExtractor = Object.fromEntries(
      [...new Set(prepared.cases.map((item) => item.extractor))]
        .sort()
        .map((extractor) => [
          extractor,
          prepared.cases.filter((item) => item.extractor === extractor).length,
        ]),
    );
    console.log(JSON.stringify({
      datasetId: prepared.dataset.datasetId,
      datasetVersion: prepared.dataset.version,
      datasetKind: prepared.dataset.kind,
      manifestSha256: prepared.manifestSha256,
      datasetSha256: prepared.datasetSha256,
      cases: prepared.cases.length,
      byExtractor,
      plannedProviderCalls: prepared.plannedProviderCalls,
      providerCallBudget: prepared.manifest.providerCallBudget,
    }, null, 2));
    return;
  }
  const report = await runExtractionEvaluation({
    manifestPath: options.manifestPath!,
    outputDirectory: options.outputDirectory!,
    resume: options.resume,
    maxCases: options.maxCases,
  });
  console.log(JSON.stringify({
    datasetId: report.datasetId,
    datasetVersion: report.datasetVersion,
    runComplete: report.runComplete,
    casesRecorded: report.casesRecorded,
    casesFailed: report.casesFailed,
    providerCallsConsumed: report.providerCallsConsumed,
    eligibleForProductionClaim: report.benchmark.eligibleForProductionClaim,
    claimBlockers: report.benchmark.claimBlockers,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Extraction evaluation failed");
  process.exitCode = 1;
});
