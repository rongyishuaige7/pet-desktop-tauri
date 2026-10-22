import React from "react";
import type { PetProfile } from "../../types";
import { BUILTIN_PRESETS } from "../../presets";

interface PresetGalleryProps {
  activePet: PetProfile | null;
  onAdopt: () => void;
  onViewCompanion: () => void;
}

/** Ready-made companions live above the advanced maker, not inside it. */
export const PresetGallery: React.FC<PresetGalleryProps> = ({
  activePet,
  onAdopt,
  onViewCompanion
}) => (
  <section className="preset-gallery" aria-labelledby="preset-gallery-title">
    <div className="preset-gallery-head">
      <div>
        <div className="eyebrow">从一次见面开始</div>
        <h2 id="preset-gallery-title">现成伙伴</h2>
        <p>选一位已经准备好的伙伴，或者慢慢制作自己的那一只。</p>
      </div>
      {activePet && (
        <button type="button" className="btn-secondary" onClick={onViewCompanion}>
          去看看我的伙伴
        </button>
      )}
    </div>

    <div className="preset-grid">
      {BUILTIN_PRESETS.map((preset) => (
        <article key={preset.id} className="preset-card">
          <div className="preset-portrait">
            <img src={preset.thumbnail} alt={preset.name} draggable={false} />
          </div>
          <div className="preset-copy">
            <div className="preset-title-row">
              <h3>{preset.name}</h3>
              <span className="chip-dim">原创伙伴</span>
            </div>
            <p>{preset.description}</p>
            <div className="preset-actions">
              <button type="button" className="btn-primary" onClick={onAdopt}>
                {activePet ? "再领养一只" : "领养咕唧"}
              </button>
              {activePet && (
                <button type="button" className="btn-secondary" onClick={onViewCompanion}>
                  回到陪伴
                </button>
              )}
            </div>
          </div>
        </article>
      ))}
    </div>

    <p className="preset-note">首版沿用现有完整素材，无需照片和在线生成服务。</p>
  </section>
);
