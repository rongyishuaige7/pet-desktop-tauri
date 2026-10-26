use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 1;
const STAGES: &[&str] = &[
    "draft",
    "characterGenerating",
    "characterReview",
    "sampleGenerating",
    "sampleReview",
    "actionsGenerating",
    "readyToSave",
    "committing",
    "committed",
    "interrupted",
    "failed",
    "uncertain",
];

static TASK_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTaskState {
    pub status: String,
    pub version: u64,
    pub frames: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestReceipt {
    pub attempt_id: String,
    pub action: String,
    pub started_at: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTask {
    pub schema_version: u32,
    pub task_id: String,
    pub revision: u64,
    pub owner_session: Option<String>,
    pub stage: String,
    pub pending_pet_id: String,
    pub photo_digest: String,
    pub species: String,
    pub appearance_notes: String,
    pub prompt_version: String,
    pub character_revision: u64,
    pub confirmed_character_revision: Option<u64>,
    pub actions: BTreeMap<String, ActionTaskState>,
    pub receipts: Vec<RequestReceipt>,
    pub committed_pet_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub task_id: String,
    pub revision: u64,
    pub stage: String,
    pub pending_pet_id: String,
    pub species: String,
    pub completed_actions: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResult {
    pub status: String,
    pub task: GenerationTask,
}

fn now_ms() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn validate(task: &GenerationTask) -> Result<(), String> {
    if task.schema_version != SCHEMA_VERSION {
        return Err("不支持的任务 schemaVersion".into());
    }
    if !valid_id(&task.task_id) || !valid_id(&task.pending_pet_id) {
        return Err("任务 id 只能包含字母、数字、- 和 _".into());
    }
    if !STAGES.contains(&task.stage.as_str()) {
        return Err(format!("未知任务阶段：{}", task.stage));
    }
    if task.species != "cat" && task.species != "dog" {
        return Err("任务物种只能是 cat 或 dog".into());
    }
    if task.prompt_version.trim().is_empty() {
        return Err("任务缺少 promptVersion".into());
    }
    if task.photo_digest.trim().is_empty() {
        return Err("任务缺少照片摘要".into());
    }
    for (action, state) in &task.actions {
        if !matches!(action.as_str(), "idle" | "sit" | "sleep" | "happy" | "walk" | "jump") {
            return Err(format!("未知动作：{action}"));
        }
        if state.frames > 60 {
            return Err(format!("{action} 帧数超过 60"));
        }
    }
    Ok(())
}

fn tasks_root(root: &Path) -> PathBuf {
    root.to_path_buf()
}

fn task_dir(root: &Path, task_id: &str) -> Result<PathBuf, String> {
    if !valid_id(task_id) {
        return Err("任务 id 只能包含字母、数字、- 和 _".into());
    }
    Ok(tasks_root(root).join(task_id))
}

fn task_file(root: &Path, task_id: &str) -> Result<PathBuf, String> {
    Ok(task_dir(root, task_id)?.join("task.json"))
}

fn read_task(root: &Path, task_id: &str) -> Result<GenerationTask, String> {
    let path = task_file(root, task_id)?;
    let bytes = std::fs::read(&path).map_err(|err| format!("读取任务失败：{err}"))?;
    let task: GenerationTask =
        serde_json::from_slice(&bytes).map_err(|err| format!("任务文件不是有效 JSON：{err}"))?;
    validate(&task)?;
    if task.task_id != task_id {
        return Err("任务文件 id 与目录不一致".into());
    }
    Ok(task)
}

fn write_task_atomic(root: &Path, task: &GenerationTask) -> Result<(), String> {
    validate(task)?;
    let dir = task_dir(root, &task.task_id)?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建任务目录失败：{err}"))?;
    let json = serde_json::to_vec(task).map_err(|err| format!("序列化任务失败：{err}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = dir.join(format!(".task-{}-{nonce}.json", std::process::id()));
    std::fs::write(&temp, json).map_err(|err| format!("写入任务暂存失败：{err}"))?;
    std::fs::rename(&temp, dir.join("task.json"))
        .map_err(|err| format!("提交任务文件失败：{err}"))?;
    Ok(())
}

pub fn create_task(root: &Path, mut task: GenerationTask) -> Result<GenerationTask, String> {
    let _guard = TASK_LOCK.lock().map_err(|_| "任务锁不可用")?;
    let dir = task_dir(root, &task.task_id)?;
    if dir.exists() {
        return Err("任务已存在，不覆盖".into());
    }
    task.schema_version = SCHEMA_VERSION;
    task.revision = 1;
    task.owner_session = None;
    task.created_at = now_ms();
    task.updated_at = task.created_at.clone();
    write_task_atomic(root, &task)?;
    Ok(task)
}

pub fn load_task(root: &Path, task_id: &str) -> Result<GenerationTask, String> {
    let _guard = TASK_LOCK.lock().map_err(|_| "任务锁不可用")?;
    read_task(root, task_id)
}

pub fn list_tasks(root: &Path) -> Result<Vec<TaskSummary>, String> {
    let _guard = TASK_LOCK.lock().map_err(|_| "任务锁不可用")?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut tasks = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|err| format!("读取任务目录失败：{err}"))? {
        let entry = entry.map_err(|err| format!("读取任务项失败：{err}"))?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let task_id = entry.file_name().to_string_lossy().to_string();
        if let Ok(task) = read_task(root, &task_id) {
            let completed_actions = task
                .actions
                .values()
                .filter(|state| state.status == "succeeded" && state.frames >= 5)
                .count();
            tasks.push(TaskSummary {
                task_id: task.task_id,
                revision: task.revision,
                stage: task.stage,
                pending_pet_id: task.pending_pet_id,
                species: task.species,
                completed_actions,
                updated_at: task.updated_at,
            });
        }
    }
    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(tasks)
}

pub fn update_task(
    root: &Path,
    mut task: GenerationTask,
    expected_revision: u64,
    owner_session: &str,
) -> Result<GenerationTask, String> {
    let _guard = TASK_LOCK.lock().map_err(|_| "任务锁不可用")?;
    let current = read_task(root, &task.task_id)?;
    if current.revision != expected_revision {
        return Err("TASK_CONFLICT：任务已被其他窗口更新".into());
    }
    if current.owner_session.as_deref() != Some(owner_session) {
        return Err("TASK_OWNER：当前窗口没有执行权".into());
    }
    if task.pending_pet_id != current.pending_pet_id {
        return Err("TASK_CONFLICT：pendingPetId 不允许更换".into());
    }
    task.schema_version = SCHEMA_VERSION;
    task.revision = current.revision + 1;
    task.created_at = current.created_at;
    task.owner_session = Some(owner_session.to_string());
    task.updated_at = now_ms();
    write_task_atomic(root, &task)?;
    Ok(task)
}

pub fn claim_task(
    root: &Path,
    task_id: &str,
    owner_session: &str,
    resume: bool,
) -> Result<ClaimResult, String> {
    let _guard = TASK_LOCK.lock().map_err(|_| "任务锁不可用")?;
    let mut task = read_task(root, task_id)?;
    if let Some(owner) = task.owner_session.as_deref() {
        if owner != owner_session {
            if !resume {
                task.stage = "interrupted".into();
                task.owner_session = None;
                task.revision += 1;
                task.updated_at = now_ms();
                write_task_atomic(root, &task)?;
                return Ok(ClaimResult {
                    status: "interrupted".into(),
                    task,
                });
            }
        }
    }
    task.owner_session = Some(owner_session.to_string());
    task.revision += 1;
    task.updated_at = now_ms();
    write_task_atomic(root, &task)?;
    Ok(ClaimResult {
        status: "claimed".into(),
        task,
    })
}

pub fn release_task(root: &Path, task_id: &str, owner_session: &str) -> Result<(), String> {
    let _guard = TASK_LOCK.lock().map_err(|_| "任务锁不可用")?;
    let mut task = read_task(root, task_id)?;
    if task.owner_session.as_deref() != Some(owner_session) {
        return Err("TASK_OWNER：当前窗口没有执行权".into());
    }
    task.owner_session = None;
    task.revision += 1;
    task.updated_at = now_ms();
    write_task_atomic(root, &task)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str) -> GenerationTask {
        GenerationTask {
            schema_version: SCHEMA_VERSION,
            task_id: id.into(),
            revision: 0,
            owner_session: None,
            stage: "draft".into(),
            pending_pet_id: format!("{id}-pet"),
            photo_digest: "abc123".into(),
            species: "cat".into(),
            appearance_notes: "橘猫".into(),
            prompt_version: "v1".into(),
            character_revision: 0,
            confirmed_character_revision: None,
            actions: BTreeMap::new(),
            receipts: Vec::new(),
            committed_pet_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn creates_loads_lists_and_never_writes_secrets() {
        let root = tempfile::tempdir().unwrap();
        let created = create_task(root.path(), task("task-1")).unwrap();
        assert_eq!(created.revision, 1);
        let loaded = load_task(root.path(), "task-1").unwrap();
        assert_eq!(loaded.pending_pet_id, "task-1-pet");
        let list = list_tasks(root.path()).unwrap();
        assert_eq!(list.len(), 1);
        let json = std::fs::read_to_string(task_file(root.path(), "task-1").unwrap()).unwrap();
        for forbidden in ["apiKey", "uploadUrl", "data:", "referenceUrl", "secret"] {
            assert!(!json.contains(forbidden));
        }
        assert!(load_task(root.path(), "../escape").is_err());
    }

    #[test]
    fn update_requires_revision_and_owner() {
        let root = tempfile::tempdir().unwrap();
        create_task(root.path(), task("task-1")).unwrap();
        let mut current = load_task(root.path(), "task-1").unwrap();
        assert!(update_task(root.path(), current.clone(), 1, "session-a").is_err());
        let claimed = claim_task(root.path(), "task-1", "session-a", false).unwrap();
        assert_eq!(claimed.status, "claimed");
        current = claimed.task;
        current.stage = "characterReview".into();
        let updated = update_task(root.path(), current.clone(), current.revision, "session-a").unwrap();
        assert_eq!(updated.stage, "characterReview");
        assert_eq!(updated.revision, current.revision + 1);
        assert!(update_task(root.path(), updated.clone(), current.revision, "session-a").is_err());
    }

    #[test]
    fn second_session_marks_interrupted_and_resume_takes_ownership() {
        let root = tempfile::tempdir().unwrap();
        create_task(root.path(), task("task-1")).unwrap();
        claim_task(root.path(), "task-1", "session-a", false).unwrap();
        let interrupted = claim_task(root.path(), "task-1", "session-b", false).unwrap();
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(interrupted.task.stage, "interrupted");
        assert_eq!(interrupted.task.owner_session, None);
        let resumed = claim_task(root.path(), "task-1", "session-b", true).unwrap();
        assert_eq!(resumed.status, "claimed");
        assert_eq!(resumed.task.owner_session.as_deref(), Some("session-b"));
    }

    #[test]
    fn corrupt_tasks_are_ignored_in_the_list() {
        let root = tempfile::tempdir().unwrap();
        create_task(root.path(), task("task-1")).unwrap();
        let bad = task_dir(root.path(), "bad-1").unwrap();
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("task.json"), b"not json").unwrap();
        let list = list_tasks(root.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].task_id, "task-1");
    }
}
