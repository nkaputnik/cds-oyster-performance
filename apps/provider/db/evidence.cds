namespace benchmark.evidence;

using { cuid, managed } from '@sap/cds/common';

entity Runs : cuid, managed {
  manifest      : LargeString;
  status        : String(16) default 'open';
  finishedAt    : Timestamp;
  finalArtifact : Association to Artifacts;
  artifacts     : Composition of many Artifacts on artifacts.run = $self;
}

@assert.unique.runPath: [run, path]
entity Artifacts : cuid, managed {
  run              : Association to Runs not null;
  path             : String(1024) not null;
  originalBytes    : Integer64 not null;
  compressedBytes  : Integer64 not null;
  originalSha256   : String(64) not null;
  compressedSha256 : String(64) not null;
  partCount        : Integer not null;
  compression      : String(8) default 'gzip';
  status           : String(16) default 'pending';
  completedAt      : Timestamp;
  parts            : Composition of many ArtifactParts on parts.artifact = $self;
}

@assert.unique.artifactOrdinal: [artifact, ordinal]
entity ArtifactParts : cuid {
  artifact : Association to Artifacts not null;
  ordinal  : Integer not null;
  bytes    : Integer not null;
  content  : LargeBinary not null;
}
