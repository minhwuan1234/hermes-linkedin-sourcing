import fs from "fs";
import path from "path";

export type CandidateRecord = {
  profile_url: string;
  [key: string]: unknown;
};

const DATA_FILE = path.resolve(
  process.cwd(),
  "data/linkedin_candidates.json"
);

function ensureDataFile(): void {
  const dir = path.dirname(DATA_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify([], null, 2),
      "utf8"
    );
  }
}

export function loadCandidates(): CandidateRecord[] {
  ensureDataFile();

  const raw = fs.readFileSync(DATA_FILE, "utf8");

  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(
      "linkedin_candidates.json must contain an array"
    );
  }

  return parsed;
}

export function saveCandidates(
  candidates: CandidateRecord[]
): void {
  ensureDataFile();

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(candidates, null, 2),
    "utf8"
  );
}

export function upsertCandidate(
  candidate: CandidateRecord
): CandidateRecord {
  if (!candidate.profile_url) {
    throw new Error(
      "Candidate profile_url is required"
    );
  }

  const candidates = loadCandidates();

  const index = candidates.findIndex(
    (item) =>
      item.profile_url === candidate.profile_url
  );

  if (index >= 0) {
    candidates[index] = {
      ...candidates[index],
      ...candidate,
    };
  } else {
    candidates.push(candidate);
  }

  saveCandidates(candidates);

  return candidate;
}

export function updateCandidateByProfileUrl(
  profileUrl: string,
  patch: Partial<CandidateRecord>
): CandidateRecord | null {
  const candidates = loadCandidates();

  const index = candidates.findIndex(
    (item) =>
      item.profile_url === profileUrl
  );

  if (index < 0) {
    return null;
  }

  candidates[index] = {
    ...candidates[index],
    ...patch,
  };

  saveCandidates(candidates);

  return candidates[index];
}
