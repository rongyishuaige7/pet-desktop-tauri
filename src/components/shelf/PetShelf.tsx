import React from "react";
import type { PetProfile } from "../../types";

interface PetShelfProps {
  pets: PetProfile[];
  activePetId: string | null;
  onDeployPet: (pet: PetProfile) => void;
  onDeletePet: (id: string) => void;
  onRenamePet: (id: string, newName: string) => void;
  onGoToWorkshop: () => void;
}

export const PetShelf: React.FC<PetShelfProps> = ({
  pets,
  activePetId,
  onDeployPet,
  onDeletePet,
  onRenamePet,
  onGoToWorkshop
}) => {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");

  const handleCommitRename = (id: string) => {
    const trimmed = editName.trim();
    if (trimmed) {
      onRenamePet(id, trimmed);
    }
    setEditingId(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
          在这里管理已保存的桌面小宠物。点击“派去桌面”可即时更换桌面上活动的小家伙。
        </p>
        <button
          type="button"
          className="btn-primary"
          style={{ height: "38px" }}
          onClick={onGoToWorkshop}
        >
          ➕ 制作新宠物
        </button>
      </div>

      {pets.length === 0 ? (
        <div
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
          <span style={{ fontSize: "40px" }}>🗃️</span>
          <p style={{ color: "var(--text-secondary)", fontWeight: 600 }}>宠物架空空如也</p>
          <button type="button" className="btn-primary" onClick={onGoToWorkshop}>
            去工坊导入第一只小宠物
          </button>
        </div>
      ) : (
        <div className="shelf-grid">
          {pets.map((pet) => {
            const isActive = pet.id === activePetId;
            const previewImg =
              pet.thumbnailImage || pet.sourceImage ||
              pet.actions?.idle?.[0] ||
              pet.actions?.sit?.[0] ||
              pet.actions?.happy?.[0];

            return (
              <div key={pet.id} className={`pet-card ${isActive ? "active-pet" : ""}`}>
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
                        onClick={() => {
                          setEditingId(pet.id);
                          setEditName(pet.name);
                        }}
                        title="重命名此宠物"
                      >
                        ✏️
                      </button>
                    </div>
                    <span className="pet-card-species">
                      {pet.species === "cat" ? "小猫" : "小狗"}
                    </span>
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center"
                  }}
                >
                  {isActive ? (
                    <span className="active-badge">正在桌面活动</span>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ height: "34px", padding: "0 12px", fontSize: "12px" }}
                      onClick={() => onDeployPet(pet)}
                    >
                      🚀 派去桌面
                    </button>
                  )}

                  <button
                    type="button"
                    style={{
                      padding: "6px 8px",
                      fontSize: "12px",
                      color: "var(--accent-coral)",
                      borderRadius: "6px"
                    }}
                    onClick={() => onDeletePet(pet.id)}
                    title="删除宠物"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
