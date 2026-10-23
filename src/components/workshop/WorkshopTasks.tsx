import React, { useEffect, useRef } from "react";
import type { WorkshopTask } from "../../types";

export const WORKSHOP_TASK_LABELS: Record<Exclude<WorkshopTask, "choose">, string> = {
  presets: "领养现成伙伴",
  import: "导入已有伙伴",
  frames: "装配动作帧",
  ai: "用照片制作"
};

interface WorkshopTaskChooserProps {
  activePetName?: string | null;
  repairPetName?: string | null;
  onSelect: (task: Exclude<WorkshopTask, "choose">) => void;
  onCancelRepair: () => void;
}

const TASKS: Array<{
  task: Exclude<WorkshopTask, "choose">;
  icon: string;
  title: string;
  description: string;
}> = [
  {
    task: "presets",
    icon: "🐾",
    title: "领养现成伙伴",
    description: "从咕唧开始，选一位现成伙伴并完成见面。"
  },
  {
    task: "import",
    icon: "📁",
    title: "导入已有伙伴",
    description: "读取本地的六动作帧包，保存到伙伴架。"
  },
  {
    task: "frames",
    icon: "🎞️",
    title: "装配动作帧",
    description: "逐动作检查帧序、补齐缺项并保存。"
  },
  {
    task: "ai",
    icon: "✨",
    title: "用照片制作",
    description: "上传照片生成角色和动作，先确认再入住。"
  }
];

export const WorkshopTaskChooser: React.FC<WorkshopTaskChooserProps> = ({
  activePetName,
  repairPetName,
  onSelect,
  onCancelRepair
}) => (
  <section className="workshop-tasks" aria-labelledby="workshop-tasks-title">
    <div className="workshop-tasks-head">
      <div>
        <h2 id="workshop-tasks-title">想做什么？</h2>
        <p>
          {activePetName
            ? `当前伙伴是「${activePetName}」。选择一个任务，直接进入对应步骤。`
            : "选择一个任务，直接进入对应步骤，不必先浏览画廊。"}
        </p>
      </div>
    </div>

    {repairPetName && (
      <div className="workshop-repair-note" role="status">
        <p>
          正在为「{repairPetName}」准备素材修复。选择“导入已有伙伴”只会更新这一位，
          不会新建伙伴。
        </p>
        <button type="button" className="btn-secondary" onClick={onCancelRepair}>
          取消修复
        </button>
      </div>
    )}

    <div className="workshop-task-grid">
      {TASKS.map((entry) => (
        <button
          key={entry.task}
          type="button"
          className="workshop-task-card"
          onClick={() => onSelect(entry.task)}
          aria-label={`${entry.title}：${entry.description}`}
        >
          <span className="workshop-task-icon" aria-hidden="true">
            {entry.icon}
          </span>
          <strong>{entry.title}</strong>
          <span>{entry.description}</span>
        </button>
      ))}
    </div>
  </section>
);

interface WorkshopTaskHeaderProps {
  task: Exclude<WorkshopTask, "choose">;
  repairPetName?: string | null;
  onBack: () => void;
}

export const WorkshopTaskHeader: React.FC<WorkshopTaskHeaderProps> = ({
  task,
  repairPetName,
  onBack
}) => {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [task, repairPetName]);

  return (
    <header className="workshop-task-header">
      <button type="button" className="btn-secondary" onClick={onBack}>
        ← 返回任务选择
      </button>
      <div>
        <h2 ref={headingRef} tabIndex={-1} id="workshop-task-title">
          {repairPetName ? `修复「${repairPetName}」的素材` : WORKSHOP_TASK_LABELS[task]}
        </h2>
        <p>
          {repairPetName
            ? "只更新这一位伙伴的素材；名字、当前选择和显示/休息状态保持不变。"
            : "本次任务和输入会在本次会话中保留；切换页面不会取消正在进行的制作。"}
        </p>
      </div>
    </header>
  );
};
