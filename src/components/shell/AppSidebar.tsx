import React from "react";
import type { PetProfile, StudioTab } from "../../types";

interface AppSidebarProps {
  currentTab: StudioTab;
  onSelectTab: (tab: StudioTab) => void;
  activePet: PetProfile | null;
  petCount: number;
  status: string;
  webMode: boolean;
  onOpenSettings: () => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  currentTab,
  onSelectTab,
  activePet,
  petCount,
  status,
  webMode,
  onOpenSettings
}) => {
  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand" aria-label="桌面贴贴宠物">
        <div className="brand-icon" aria-hidden="true">🐾</div>
        <div className="brand-info">
          <span className="brand-title">桌面贴贴宠物</span>
          <span className="brand-badge">Companion Studio</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        <button
          type="button"
          className={`nav-item ${currentTab === "stage" ? "active" : ""}`}
          onClick={() => onSelectTab("stage")}
          aria-label="陪伴"
          title="陪伴"
        >
          <span className="nav-icon">✨</span>
          <span>陪伴</span>
        </button>

        <button
          type="button"
          className={`nav-item ${currentTab === "workshop" ? "active" : ""}`}
          onClick={() => onSelectTab("workshop")}
          aria-label="领养与制作"
          title="领养与制作"
        >
          <span className="nav-icon">🎨</span>
          <span>领养与制作</span>
        </button>

        <button
          type="button"
          className={`nav-item ${currentTab === "shelf" ? "active" : ""}`}
          onClick={() => onSelectTab("shelf")}
          aria-label="我的伙伴"
          title="我的伙伴"
        >
          <span className="nav-icon">🗃️</span>
          <span>我的伙伴 ({petCount})</span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-settings"
          onClick={onOpenSettings}
          aria-label="偏好设置"
          title="偏好设置"
        >
          <span aria-hidden="true">⚙️</span>
          <span className="sidebar-settings-label">偏好设置</span>
        </button>
        {activePet ? (
          <div className="active-pet-widget">
            <div className="widget-avatar">
              <img
                key={activePet.id}
                src={
                  activePet.sourceImage ||
                  activePet.thumbnailImage || activePet.actions?.idle?.[0]
                }
                alt={activePet.name}
                onLoad={(e) => { e.currentTarget.style.display = ""; }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
            <div className="widget-details">
              <span className="widget-name">{activePet.name}</span>
              <span className="widget-status">{webMode ? `网页演示 · ${status}` : status}</span>
            </div>
          </div>
        ) : (
          <div className="active-pet-widget">
            <div className="widget-avatar">💤</div>
            <div className="widget-details">
              <span className="widget-name">等待入住</span>
              <span className="widget-status" style={{ color: "var(--text-tertiary)" }}>
                {webMode ? "网页演示" : status}
              </span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
