import React from "react";
import type { PetProfile, StudioTab } from "../../types";

interface AppSidebarProps {
  currentTab: StudioTab;
  onSelectTab: (tab: StudioTab) => void;
  activePet: PetProfile | null;
  petCount: number;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  currentTab,
  onSelectTab,
  activePet,
  petCount
}) => {
  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <div className="brand-icon">🐾</div>
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
        >
          <span className="nav-icon">✨</span>
          <span>互动伴侣台</span>
        </button>

        <button
          type="button"
          className={`nav-item ${currentTab === "workshop" ? "active" : ""}`}
          onClick={() => onSelectTab("workshop")}
        >
          <span className="nav-icon">🎨</span>
          <span>宠物工坊</span>
        </button>

        <button
          type="button"
          className={`nav-item ${currentTab === "shelf" ? "active" : ""}`}
          onClick={() => onSelectTab("shelf")}
        >
          <span className="nav-icon">🗃️</span>
          <span>我的宠物架 ({petCount})</span>
        </button>
      </nav>

      <div className="sidebar-footer">
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
              <span className="widget-status">桌面伴侣在线</span>
            </div>
          </div>
        ) : (
          <div className="active-pet-widget">
            <div className="widget-avatar">💤</div>
            <div className="widget-details">
              <span className="widget-name">等待入住</span>
              <span className="widget-status" style={{ color: "var(--text-tertiary)" }}>
                暂无宠物
              </span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
