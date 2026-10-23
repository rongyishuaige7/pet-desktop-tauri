import React from "react";
import type { PetProfile } from "../../types";
import { DEFAULT_PRESET_FRAME_DIR } from "../../config";
import { formatSnoozeTime } from "../../native-pet-state";
import type { NativePetState, SnoozeMinutes } from "../../native-pet-types";
import type { RemovedPetRecord } from "../../storage";
import { SnoozeMenu } from "../stage/SnoozeMenu";

interface PetShelfProps {
  pets: PetProfile[];
  activePetId: string | null;
  nativeState: NativePetState;
  displayRetryPetId?: string | null;
  assetErrorPetId?: string | null;
  hasRecovery?: boolean;
  removedPets?: RemovedPetRecord[];
  onDeployPet: (pet: PetProfile) => Promise<void> | void;
  onRemovePet: (pet: PetProfile) => Promise<void> | void;
  onRestoreRemoved: (
    id: string,
    removalId: string,
    mode: "shelf"
  ) => Promise<void> | void;
  onRenamePet: (id: string, newName: string) => Promise<void> | void;
  onRecallPet: (pet: PetProfile) => Promise<void> | void;
  onSnoozePet: (pet: PetProfile, minutes: SnoozeMinutes) => Promise<void> | void;
  onKeepHiddenPet: (pet: PetProfile) => Promise<void> | void;
  onRetryDisplayPet: (petId: string) => Promise<void> | void;
  onRetryAssetPet: (petId: string) => Promise<void> | void;
  onResetPositionPet: (pet: PetProfile) => Promise<void> | void;
  onShowRecovery: () => void;
  onGoToCompanion: () => void;
  onStartAdoption: () => void;
  onCreatePet: () => void;
  onImportPet: () => void;
}

type CardTone = "live" | "hidden" | "snoozed" | "warning" | "syncing";

interface CardStatus {
  label: string;
  tone: CardTone;
  detail?: string;
}

interface CardAction {
  label: string;
  run: () => Promise<void> | void;
  disabled?: boolean;
}

function closeMenu(event: React.MouseEvent<HTMLElement>) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

export const PetShelf: React.FC<PetShelfProps> = ({
  pets,
  activePetId,
  nativeState,
  displayRetryPetId = null,
  assetErrorPetId = null,
  hasRecovery = false,
  removedPets = [],
  onDeployPet,
  onRemovePet,
  onRestoreRemoved,
  onRenamePet,
  onRecallPet,
  onSnoozePet,
  onKeepHiddenPet,
  onRetryDisplayPet,
  onRetryAssetPet,
  onResetPositionPet,
  onShowRecovery,
  onGoToCompanion,
  onStartAdoption,
  onCreatePet,
  onImportPet
}) => {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [errorId, setErrorId] = React.useState<string | null>(null);

  const handleCommitRename = (id: string) => {
    const trimmed = editName.trim();
    if (trimmed) {
      onRenamePet(id, trimmed);
    }
    setEditingId(null);
  };

  async function run(petId: string, action: () => Promise<void> | void) {
    if (pendingId) return;
    setPendingId(petId);
    setErrorId(null);
    try {
      await action();
    } catch {
      // The shared recovery panel carries the actionable detail; the card
      // keeps a short note so the failure is visible where it happened.
      setErrorId(petId);
    } finally {
      setPendingId(null);
    }
  }

  function startRename(pet: PetProfile) {
    setEditingId(pet.id);
    setEditName(pet.name);
  }

  function replacementName(pet: PetProfile) {
    const remaining = pets
      .filter((candidate) => candidate.id !== pet.id)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      );
    return remaining[0]?.name ?? null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
          当前伙伴的状态和操作都在卡片上；收起或休息不会移除资料。
        </p>
        <button
          type="button"
          className="btn-primary"
          style={{ height: "38px" }}
          onClick={onCreatePet}
        >
          ➕ 制作新宠物
        </button>
      </div>

      <section className="shelf-removed" aria-labelledby="shelf-removed-title">
        <div className="shelf-removed-head">
          <div>
            <h2 id="shelf-removed-title">最近移除 ({removedPets.length})</h2>
            <p>恢复只放回伙伴架，不改变当前桌面伙伴；资料和素材仍在本机。</p>
          </div>
        </div>
        {removedPets.length === 0 ? (
          <p className="shelf-removed-empty">还没有最近移除的伙伴。</p>
        ) : (
          <div className="shelf-removed-grid">
            {removedPets.map((record) => {
              const preview =
                record.pet.thumbnailImage ||
                record.pet.sourceImage ||
                record.pet.actions?.idle?.[0];
              return (
                <div key={record.id} className="removed-card">
                  <div className="removed-card-avatar">
                    {preview ? (
                      <img src={preview} alt={record.pet.name} />
                    ) : (
                      <span aria-hidden="true">
                        {record.pet.species === "cat" ? "🐱" : "🐶"}
                      </span>
                    )}
                  </div>
                  <div className="removed-card-body">
                    <strong>{record.pet.name}</strong>
                    <span>
                      {new Date(record.removedAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                      {record.wasActive ? " · 移除时是当前伙伴" : " · 未在桌面"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary removed-restore"
                    onClick={() =>
                      void run(record.id, () =>
                        onRestoreRemoved(record.id, record.removalId, "shelf")
                      )
                    }
                    disabled={pendingId !== null}
                  >
                    恢复到伙伴架
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {pets.length === 0 ? (
        <div
          className="shelf-empty"
          style={{
            padding: "60px 20px",
            textAlign: "center",
            background: "var(--bg-glass-card)",
            borderRadius: "var(--radius-xl)",
            border: "1px solid var(--border-subtle)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px"
          }}
        >
          <span style={{ fontSize: "40px" }}>🌱</span>
          <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>这里暂时没有伙伴</p>
          <p style={{ color: "var(--text-tertiary)", fontSize: "12px" }}>
            可以领养咕唧，也可以带回你已经制作好的伙伴。
          </p>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
            <button type="button" className="btn-primary" onClick={onStartAdoption}>
              去领养
            </button>
            <button type="button" className="btn-secondary" onClick={onImportPet}>
              导入已有伙伴
            </button>
          </div>
        </div>
      ) : (
        <div className="shelf-grid">
          {pets.map((pet) => {
            const isActive = pet.id === activePetId;
            const nativeMatches = isActive && nativeState.petId === pet.id;
            const syncing =
              isActive &&
              (nativeState.availability === "loading" || nativeState.pending);
            const needsRecovery =
              isActive && !syncing && nativeState.petId !== pet.id;
            const assetError =
              isActive &&
              (assetErrorPetId === pet.id ||
                (nativeMatches && nativeState.availability === "error"));
            const displayPending =
              isActive && displayRetryPetId === pet.id && !assetError;
            const pending = pendingId === pet.id;
            const actionsDisabled = pendingId !== null;

            let status: CardStatus | null = null;
            let primary: CardAction;
            let secondary: CardAction | null = null;
            let showSnoozeMenu = false;

            if (!isActive) {
              primary = { label: "派去桌面", run: () => onDeployPet(pet) };
            } else if (syncing) {
              status = { label: "正在同步…", tone: "syncing" };
              primary = { label: "正在同步…", run: () => undefined, disabled: true };
            } else if (assetError) {
              status = {
                label: "素材需要恢复",
                tone: "warning",
                detail: "动作素材暂时不可用；资料和当前选择仍然保留。"
              };
              primary = { label: "恢复素材", run: () => onRetryAssetPet(pet.id) };
              secondary = hasRecovery
                ? { label: "查看详情", run: onShowRecovery }
                : null;
            } else if (displayPending) {
              status = {
                label: "等待显示",
                tone: "warning",
                detail: "资料和选择已保存，只差桌面确认显示。"
              };
              primary = { label: "重试显示", run: () => onRetryDisplayPet(pet.id) };
              secondary = hasRecovery
                ? { label: "查看详情", run: onShowRecovery }
                : null;
            } else if (needsRecovery) {
              status = {
                label: "需要恢复",
                tone: "warning",
                detail: nativeState.petId
                  ? "桌面当前显示的是另一位伙伴；唤回会重新同步这一位。"
                  : "这一位还没有同步到桌面；唤回会重新加载并显示。"
              };
              primary = { label: "恢复伙伴", run: () => onRecallPet(pet) };
              secondary = hasRecovery
                ? { label: "查看详情", run: onShowRecovery }
                : null;
            } else if (nativeState.visibilityMode === "snoozed") {
              status = {
                label: nativeState.snoozeUntilMs
                  ? `休息中 · 到 ${formatSnoozeTime(nativeState.snoozeUntilMs)}`
                  : "休息中",
                tone: "snoozed"
              };
              primary = { label: "提前唤回", run: () => onRecallPet(pet) };
              showSnoozeMenu = true;
            } else if (nativeState.visibilityMode === "hidden") {
              status = { label: "已收起", tone: "hidden" };
              primary = { label: "唤回伙伴", run: () => onRecallPet(pet) };
            } else if (nativeState.visible) {
              status = { label: "显示中", tone: "live" };
              primary = { label: "回到陪伴", run: onGoToCompanion };
            } else {
              status = { label: "等待显示", tone: "warning" };
              primary = { label: "唤回伙伴", run: () => onRecallPet(pet) };
            }

            const previewImg =
              pet.thumbnailImage || pet.sourceImage ||
              pet.actions?.idle?.[0] ||
              pet.actions?.sit?.[0] ||
              pet.actions?.happy?.[0];

            return (
              <div
                key={pet.id}
                className={`pet-card ${isActive ? "active-pet" : ""} ${pending ? "is-busy" : ""}`}
                aria-busy={pending || undefined}
              >
                <div className="pet-card-avatar">
                  {previewImg ? (
                    <img src={previewImg} alt={pet.name} />
                  ) : (
                    <span style={{ fontSize: "48px" }}>{pet.species === "cat" ? "🐱" : "🐶"}</span>
                  )}
                </div>

                {editingId === pet.id ? (
                  <div className="pet-card-rename-row">
                    <input
                      type="text"
                      className="pet-rename-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) handleCommitRename(pet.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                      maxLength={20}
                      placeholder="输入新名字..."
                    />
                    <button
                      type="button"
                      className="btn-icon-save"
                      onClick={() => handleCommitRename(pet.id)}
                      title="保存新名字"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className="btn-icon-cancel"
                      onClick={() => setEditingId(null)}
                      title="取消"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="pet-card-header">
                    <div className="pet-name-group">
                      <span className="pet-card-name" title={pet.name}>{pet.name}</span>
                      <button
                        type="button"
                        className="btn-rename-trigger"
                        onClick={() => startRename(pet)}
                        title="重命名此宠物"
                        aria-label={`重命名${pet.name}`}
                      >
                        ✏️
                      </button>
                    </div>
                    <span className="pet-card-species">
                      {pet.frameRoot === DEFAULT_PRESET_FRAME_DIR && pet.species === "dog"
                        ? "原创伙伴"
                        : pet.species === "cat"
                          ? "小猫"
                          : "小狗"}
                    </span>
                  </div>
                )}

                {status && (
                  <div className={`pet-card-status is-${status.tone}`} title={status.detail}>
                    <span className="status-dot" aria-hidden="true" />
                    <span>{status.label}</span>
                  </div>
                )}

                <div className="pet-card-footer">
                  <div className="pet-card-action-row">
                    <button
                      type="button"
                      className="btn-primary pet-card-action"
                      onClick={() => void run(pet.id, primary.run)}
                      disabled={actionsDisabled || primary.disabled}
                    >
                      {pending ? "正在处理…" : primary.label}
                    </button>
                    {showSnoozeMenu && (
                      <SnoozeMenu
                        snoozed
                        compact
                        busy={actionsDisabled}
                        onSnooze={(minutes) =>
                          void run(pet.id, () => onSnoozePet(pet, minutes))
                        }
                        onKeepHidden={() =>
                          void run(pet.id, () => onKeepHiddenPet(pet))
                        }
                      />
                    )}
                    {secondary && (
                      <button
                        type="button"
                        className="btn-secondary pet-card-action"
                        onClick={() => void run(pet.id, secondary.run)}
                        disabled={actionsDisabled}
                      >
                        {secondary.label}
                      </button>
                    )}
                  </div>

                  <details className="pet-card-more">
                    <summary aria-label={`更多操作：${pet.name}`}>更多</summary>
                    <div className="pet-card-more-menu">
                      <button
                        type="button"
                        onClick={(event) => {
                          closeMenu(event);
                          startRename(pet);
                        }}
                        disabled={actionsDisabled}
                      >
                        重命名
                      </button>
                      {isActive && nativeMatches && nativeState.capabilities.resetPosition && (
                        <>
                          <button
                            type="button"
                            onClick={(event) => {
                              closeMenu(event);
                              void run(pet.id, () => onResetPositionPet(pet));
                            }}
                            disabled={actionsDisabled}
                          >
                            找回位置
                          </button>
                          <p className="pet-card-more-note">
                            只移动桌面位置，不改变显示或休息状态。
                          </p>
                        </>
                      )}
                      {hasRecovery && (
                        <button
                          type="button"
                          onClick={(event) => {
                            closeMenu(event);
                            onShowRecovery();
                          }}
                        >
                          查看恢复提示
                        </button>
                      )}
                      {isActive && (
                        <p className="pet-card-more-note">
                          {replacementName(pet)
                            ? `移除后由「${replacementName(pet)}」接替桌面。`
                            : "移除后桌面将暂时没有伙伴。"}
                        </p>
                      )}
                      <button
                        type="button"
                        className="danger"
                        onClick={(event) => {
                          closeMenu(event);
                          void run(pet.id, () => onRemovePet(pet));
                        }}
                        disabled={actionsDisabled}
                      >
                        移到最近移除
                      </button>
                    </div>
                  </details>
                </div>

                {errorId === pet.id && (
                  <p className="pet-card-note" role="status">
                    这次操作没有完成，资料仍在。可以重试，或查看上方的恢复提示。
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
