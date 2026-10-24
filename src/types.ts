export type PetSpecies = "cat" | "dog";

export type PetAction = "idle" | "sit" | "sleep" | "happy" | "walk" | "jump";

export type ActionFrameSet = Record<PetAction, string[]>;

export interface PetProfile {
  id: string;
  name: string;
  species: PetSpecies;
  style: "q-sticker";
  storageMode?: "embedded" | "preset-root";
  assetMode?: "managed" | "external";
  assetId?: string;
  frameRoot?: string;
  createdAt: string;
  sourceImage: string;
  thumbnailImage?: string;
  actions: ActionFrameSet;
  currentAction: PetAction;
  actionStartedAt?: string;
  scale: number;
}

export const PET_ACTIONS: Array<{ id: PetAction; label: string }> = [
  { id: "idle", label: "待机" },
  { id: "sit", label: "坐下" },
  { id: "sleep", label: "睡觉" },
  { id: "happy", label: "开心" },
  { id: "walk", label: "走路" },
  { id: "jump", label: "跳跃" }
];

export const STORAGE_KEY = "desktop-sticker-pet:v1";
export const PET_CHANNEL = "desktop-sticker-pet-events";

export type StudioTab = "stage" | "workshop" | "shelf";
export type WorkshopTask = "choose" | "presets" | "import" | "frames" | "ai";

export interface FrameInspectionAction {
  action: PetAction;
  frames: number;
  minFrames: number;
  maxFrames: number;
  issues: string[];
}

export interface CreationDraft {
  schemaVersion: 1;
  draftId: string;
  revision: number;
  pendingPetId: string;
  name: string;
  species: PetSpecies;
  manualFrames: ActionFrameSet;
  updatedAt: string;
}

export interface ExportedPetPackage {
  root: string;
}

export interface PackageSummary {
  name: string;
  species: PetSpecies;
  style: "q-sticker";
  createdAt: string;
  actions: Record<string, number>;
  thumbnail: string | null;
}

export interface ImportedPetPackage {
  assetId: string;
  root: string;
  name: string;
  species: PetSpecies;
  style: "q-sticker";
  createdAt: string;
  thumbnail: string | null;
}

export interface ManagedAsset {
  assetId: string;
  root: string;
  totalBytes: number;
}

export interface FrameInspection {
  root: string;
  actions: FrameInspectionAction[];
  missingActions: PetAction[];
  totalBytes: number;
  decodedBytes: number;
  valid: boolean;
  issues: string[];
  globalIssues: string[];
  thumbnail: string | null;
}
