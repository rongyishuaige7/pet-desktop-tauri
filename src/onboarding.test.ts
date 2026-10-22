import { describe, expect, it } from "vitest";
import type { PetProfile } from "./types";
import {
  completeOnboarding,
  createOnboardingRecord,
  decideOnboardingStart,
  markAdoptionCommitted,
  normalizeOnboardingRecord,
  prepareAdoption
} from "./onboarding";

function pet(id: string): PetProfile {
  return {
    id,
    name: id,
    species: "dog",
    style: "q-sticker",
    createdAt: "2026-10-21T00:00:00Z",
    sourceImage: "/frame-pack/idle/000.png",
    actions: { idle: [], sit: [], sleep: [], happy: [], walk: [], jump: [] },
    currentAction: "idle",
    actionStartedAt: "2026-10-21T00:00:00Z",
    scale: 1
  };
}

describe("onboarding records", () => {
  it("rejects unreadable records instead of treating them as a clean install", () => {
    expect(normalizeOnboardingRecord(null)).toBeNull();
    expect(normalizeOnboardingRecord({})).toBeNull();
    expect(normalizeOnboardingRecord({ state: "in_progress" })).toBeNull();
    expect(normalizeOnboardingRecord({ state: "unknown", step: "choose" })).toBeNull();
  });

  it("normalizes fields and clamps the draft name", () => {
    const record = normalizeOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "一二三四五六七八九十一二三四五六七八九十多余",
      adoptionId: "  adoption-a  ",
      pendingPetId: "",
      phase: "unknown",
      updatedAt: 42
    });
    expect(record?.draftName).toHaveLength(20);
    expect(record?.adoptionId).toBe("adoption-a");
    expect(record?.pendingPetId).toBeNull();
    expect(record?.phase).toBeNull();
    expect(record?.presetId).toBe("guji");
  });
});

describe("onboarding start decisions", () => {
  it("starts clean only when the collection was never initialized and has no pets", () => {
    const start = decideOnboardingStart({
      record: null,
      initialized: false,
      pets: [],
      activePetId: null
    });
    expect(start.kind).toBe("clean");
    expect(start.step).toBe("choose");
  });

  it("treats an initialized empty collection as an existing user", () => {
    const start = decideOnboardingStart({
      record: null,
      initialized: true,
      pets: [],
      activePetId: null
    });
    expect(start.kind).toBe("complete");
    expect(start.record.state).toBe("completed");
  });

  it("treats existing profiles as an existing user even without the flag", () => {
    const start = decideOnboardingStart({
      record: null,
      initialized: false,
      pets: [pet("A")],
      activePetId: "A"
    });
    expect(start.kind).toBe("complete");
    expect(start.record.confirmedPetId).toBe("A");
  });

  it("resumes choose and name steps", () => {
    const choose = decideOnboardingStart({
      record: createOnboardingRecord({ step: "choose" }),
      initialized: false,
      pets: [],
      activePetId: null
    });
    expect(choose.kind).toBe("show");
    expect(choose.step).toBe("choose");

    const name = decideOnboardingStart({
      record: createOnboardingRecord({ step: "name", draftName: "团子" }),
      initialized: false,
      pets: [],
      activePetId: null
    });
    expect(name.kind).toBe("show");
    expect(name.step).toBe("name");
    expect(name.record.draftName).toBe("团子");
  });

  it("resumes a prepared adoption at the name step with stable ids", () => {
    const record = createOnboardingRecord({
      step: "name",
      phase: "prepared",
      adoptionId: "adoption-a",
      pendingPetId: "pending-a"
    });
    const start = decideOnboardingStart({
      record,
      initialized: false,
      pets: [],
      activePetId: null
    });
    expect(start.kind).toBe("show");
    expect(start.step).toBe("name");
    expect(start.record.pendingPetId).toBe("pending-a");
  });

  it("opens the meet step when the committed pet exists", () => {
    const record = createOnboardingRecord({
      step: "meet",
      phase: "committed",
      confirmedPetId: "pet-a"
    });
    const start = decideOnboardingStart({
      record,
      initialized: true,
      pets: [pet("pet-a")],
      activePetId: "pet-a"
    });
    expect(start.kind).toBe("show");
    expect(start.step).toBe("meet");
  });

  it("ends the tutorial without recreating a deliberately deleted pet", () => {
    const record = createOnboardingRecord({
      step: "meet",
      phase: "committed",
      confirmedPetId: "pet-a"
    });
    const start = decideOnboardingStart({
      record,
      initialized: true,
      pets: [],
      activePetId: null
    });
    expect(start.kind).toBe("complete");
    expect(start.record.state).toBe("completed");
    expect(start.record.confirmedPetId).toBeNull();
  });

  it("does not reopen completed or dismissed records", () => {
    for (const state of ["completed", "dismissed"] as const) {
      const start = decideOnboardingStart({
        record: createOnboardingRecord({ state }),
        initialized: false,
        pets: [],
        activePetId: null
      });
      expect(start.kind).toBe("complete");
    }
  });
});

describe("adoption planning", () => {
  it("reuses ids from a prepared record", () => {
    const record = createOnboardingRecord({
      phase: "prepared",
      adoptionId: "adoption-a",
      pendingPetId: "pending-a",
      previousActivePetId: "previous-a"
    });
    const plan = prepareAdoption(record, "  团子  ", "ignored", () => "new-id");
    expect(plan.adoptionId).toBe("adoption-a");
    expect(plan.pendingPetId).toBe("pending-a");
    expect(plan.previousActivePetId).toBe("previous-a");
    expect(plan.name).toBe("团子");
    expect(plan.record.phase).toBe("prepared");
  });

  it("generates stable ids once and rejects empty names", () => {
    let calls = 0;
    const plan = prepareAdoption(createOnboardingRecord(), "咕唧", null, () => `id-${++calls}`);
    expect(plan.adoptionId).toBe("id-1");
    expect(plan.pendingPetId).toBe("id-2");
    expect(() => prepareAdoption(createOnboardingRecord(), "   ", null)).toThrow("起个名字");
  });

  it("marks the committed pet and completes the tutorial", () => {
    const prepared = prepareAdoption(createOnboardingRecord(), "咕唧", "old").record;
    const committed = markAdoptionCommitted(prepared, "pending-a");
    expect(committed.step).toBe("meet");
    expect(committed.phase).toBe("committed");
    expect(committed.confirmedPetId).toBe("pending-a");
    const completed = completeOnboarding(committed, "pending-a");
    expect(completed.state).toBe("completed");
  });
});

describe("second adoption resume", () => {
  it("ignores an old confirmed pet while a new draft is prepared", () => {
    const record = createOnboardingRecord({
      step: "name",
      draftName: "新伙伴",
      phase: "prepared",
      confirmedPetId: "A",
      pendingPetId: "new-pet",
      adoptionId: "new-adoption"
    });
    const start = decideOnboardingStart({
      record,
      initialized: true,
      pets: [pet("A")],
      activePetId: "A"
    });
    expect(start.kind).toBe("show");
    expect(start.step).toBe("name");
    expect(start.record.confirmedPetId).toBe("A");
  });

  it("opens the meet step only when the prepared pending pet exists", () => {
    const record = createOnboardingRecord({
      step: "meet",
      phase: "prepared",
      confirmedPetId: "A",
      pendingPetId: "new-pet"
    });
    const start = decideOnboardingStart({
      record,
      initialized: true,
      pets: [pet("A"), pet("new-pet")],
      activePetId: "A"
    });
    expect(start.kind).toBe("show");
    expect(start.step).toBe("meet");
    expect(start.record.confirmedPetId).toBe("new-pet");
  });
});
