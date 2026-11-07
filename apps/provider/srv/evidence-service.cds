using { benchmark.evidence as evidence } from '../db/evidence';

@path: '/benchmark-evidence'
@requires: 'BenchmarkRecorder'
service BenchmarkEvidenceService {
  @readonly entity Runs as projection on evidence.Runs excluding { artifacts };
  @readonly entity Artifacts as projection on evidence.Artifacts excluding { parts };

  action beginRun(manifest: LargeString) returns Runs;
  action beginArtifact(runID: UUID, path: String(1024), originalBytes: Integer64,
    compressedBytes: Integer64, originalSha256: String(64),
    compressedSha256: String(64), partCount: Integer) returns Artifacts;
  action putPart(artifactID: UUID, ordinal: Integer, content: LargeBinary);
  action completeArtifact(artifactID: UUID) returns Artifacts;
  action getPart(artifactID: UUID, ordinal: Integer) returns LargeBinary;
  action finishRun(runID: UUID, status: String(16), finalArtifactID: UUID) returns Runs;
}
