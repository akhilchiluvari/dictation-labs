#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use arboard::Clipboard;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::process::Command;
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
struct AppConfig {
    enabled: bool,
    launch_at_login: bool,
    show_floating_pill: bool,
    hotkey: String,
    mode: String,
    double_tap_hands_free: bool,
    language: String,
    provider: String,
    cleanup_enabled: bool,
    style: String,
    retain_raw_audio: bool,
    restore_clipboard: bool,
    auto_retry: bool,
    max_duration_seconds: u32,
    cloud_credit_limit: u32,
    cloud_minutes_used: u32,
    vocabulary: Vec<String>,
    profile_notes: String,
    whisper_binary: String,
    whisper_model: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            launch_at_login: false,
            show_floating_pill: true,
            hotkey: "Alt+Space".into(),
            mode: "hold".into(),
            double_tap_hands_free: true,
            language: "en".into(),
            provider: "local".into(),
            cleanup_enabled: true,
            style: "natural".into(),
            retain_raw_audio: true,
            restore_clipboard: false,
            auto_retry: true,
            max_duration_seconds: 300,
            cloud_credit_limit: 120,
            cloud_minutes_used: 0,
            vocabulary: vec![
                "Wispr Flow".into(),
                "Trinity Protocol".into(),
                "Dictation Lab".into(),
            ],
            profile_notes: String::new(),
            whisper_binary: env_or_config("WHISPER_BINARY", "whisper-cli"),
            whisper_model: env_value("WHISPER_MODEL").unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingInfo {
    id: String,
    path: String,
    duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobRecord {
    id: String,
    created_at: u64,
    status: String,
    audio_path: String,
    duration_ms: u64,
    transcript: String,
    error: String,
    attempts: u32,
}

#[derive(Debug, Clone, Serialize)]
struct HotkeyEvent {
    state: String,
}

struct AudioRecorder {
    samples: Arc<Mutex<Vec<i16>>>,
    stop_tx: Sender<()>,
    join: Option<JoinHandle<Result<AudioSpec, String>>>,
}

#[derive(Clone, Copy)]
struct AudioSpec {
    sample_rate: u32,
    channels: u16,
}

struct AppState {
    data_dir: PathBuf,
    config: Mutex<AppConfig>,
    recorder: Mutex<Option<AudioRecorder>>,
    running_jobs: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl AppState {
    fn config_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    fn jobs_path(&self) -> PathBuf {
        self.data_dir.join("jobs.json")
    }

    fn load_config(data_dir: &Path) -> AppConfig {
        let path = data_dir.join("settings.json");
        let mut config = fs::read_to_string(path)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default();
        apply_environment_defaults(&mut config);
        config
    }

    fn save_config(&self, config: &AppConfig) -> Result<(), String> {
        fs::create_dir_all(&self.data_dir).map_err(|error| error.to_string())?;
        let body = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
        fs::write(self.config_path(), body).map_err(|error| error.to_string())
    }

    fn load_jobs(&self) -> Vec<JobRecord> {
        fs::read_to_string(self.jobs_path())
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default()
    }

    fn save_jobs(&self, jobs: &[JobRecord]) -> Result<(), String> {
        fs::create_dir_all(&self.data_dir).map_err(|error| error.to_string())?;
        let body = serde_json::to_string_pretty(jobs).map_err(|error| error.to_string())?;
        fs::write(self.jobs_path(), body).map_err(|error| error.to_string())
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_or_config(name: &str, fallback: &str) -> String {
    env_value(name).unwrap_or_else(|| fallback.into())
}

fn apply_environment_defaults(config: &mut AppConfig) {
    if config.whisper_binary.trim().is_empty() {
        config.whisper_binary = env_or_config("WHISPER_BINARY", "whisper-cli");
    }
    if config.whisper_model.trim().is_empty() {
        config.whisper_model = env_value("WHISPER_MODEL").unwrap_or_default();
    }
}

fn load_environment() {
    if dotenvy::dotenv().is_ok() {
        return;
    }

    let mut directory = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    while let Some(path) = directory {
        if dotenvy::from_path(path.join(".env")).is_ok() {
            break;
        }
        directory = path.parent().map(Path::to_path_buf);
    }
}

fn update_job(state: &AppState, job: JobRecord) -> Result<JobRecord, String> {
    let mut jobs = state.load_jobs();
    if let Some(existing) = jobs.iter_mut().find(|item| item.id == job.id) {
        *existing = job.clone();
    } else {
        jobs.push(job.clone());
    }
    state.save_jobs(&jobs)?;
    Ok(job)
}

fn shortcut_from_string(value: &str) -> Result<Shortcut, String> {
    let mut modifiers = Modifiers::empty();
    let mut code = None;
    for part in value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        match part.to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" => modifiers |= Modifiers::CONTROL,
            "ALT" | "OPTION" => modifiers |= Modifiers::ALT,
            "SHIFT" => modifiers |= Modifiers::SHIFT,
            "SUPER" | "WIN" | "META" | "CMD" => modifiers |= Modifiers::SUPER,
            "SPACE" => code = Some(Code::Space),
            "F1" => code = Some(Code::F1),
            "F2" => code = Some(Code::F2),
            "F3" => code = Some(Code::F3),
            "F4" => code = Some(Code::F4),
            "F5" => code = Some(Code::F5),
            "F6" => code = Some(Code::F6),
            "F7" => code = Some(Code::F7),
            "F8" => code = Some(Code::F8),
            "F9" => code = Some(Code::F9),
            "F10" => code = Some(Code::F10),
            "F11" => code = Some(Code::F11),
            "F12" => code = Some(Code::F12),
            key if key.len() == 1 => {
                let character = key.chars().next().unwrap();
                let key_code = match character {
                    'A' => Code::KeyA,
                    'B' => Code::KeyB,
                    'C' => Code::KeyC,
                    'D' => Code::KeyD,
                    'E' => Code::KeyE,
                    'F' => Code::KeyF,
                    'G' => Code::KeyG,
                    'H' => Code::KeyH,
                    'I' => Code::KeyI,
                    'J' => Code::KeyJ,
                    'K' => Code::KeyK,
                    'L' => Code::KeyL,
                    'M' => Code::KeyM,
                    'N' => Code::KeyN,
                    'O' => Code::KeyO,
                    'P' => Code::KeyP,
                    'Q' => Code::KeyQ,
                    'R' => Code::KeyR,
                    'S' => Code::KeyS,
                    'T' => Code::KeyT,
                    'U' => Code::KeyU,
                    'V' => Code::KeyV,
                    'W' => Code::KeyW,
                    'X' => Code::KeyX,
                    'Y' => Code::KeyY,
                    'Z' => Code::KeyZ,
                    _ => return Err(format!("Unsupported shortcut key: {part}")),
                };
                code = Some(key_code);
            }
            _ => return Err(format!("Unsupported shortcut key: {part}")),
        }
    }
    code.map(|key| Shortcut::new((!modifiers.is_empty()).then_some(modifiers), key))
        .ok_or_else(|| "A shortcut needs a key such as Space, F9, or D.".into())
}

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

fn u16_to_i16(sample: u16) -> i16 {
    (sample as i32 - i16::MAX as i32 - 1) as i16
}

fn capture_audio_thread(
    samples: Arc<Mutex<Vec<i16>>>,
    stop_rx: Receiver<()>,
    ready_tx: Sender<Result<AudioSpec, String>>,
) -> Result<AudioSpec, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No default microphone was found.".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("Could not read microphone format: {error}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels;
    let sample_rate = config.sample_rate.0;
    let capture = Arc::clone(&samples);
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                if let Ok(mut target) = capture.lock() {
                    target.extend(data.iter().copied().map(f32_to_i16));
                }
            },
            |error| eprintln!("Dictation Lab audio stream error: {error}"),
            None,
        ),
        cpal::SampleFormat::I16 => {
            let capture = Arc::clone(&samples);
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    if let Ok(mut target) = capture.lock() {
                        target.extend_from_slice(data);
                    }
                },
                |error| eprintln!("Dictation Lab audio stream error: {error}"),
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let capture = Arc::clone(&samples);
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    if let Ok(mut target) = capture.lock() {
                        target.extend(data.iter().copied().map(u16_to_i16));
                    }
                },
                |error| eprintln!("Dictation Lab audio stream error: {error}"),
                None,
            )
        }
        format => return Err(format!("Unsupported microphone sample format: {format:?}")),
    }
    .map_err(|error| format!("Could not start microphone: {error}"))?;

    stream
        .play()
        .map_err(|error| format!("Could not start microphone stream: {error}"))?;
    let audio_spec = AudioSpec {
        sample_rate,
        channels,
    };
    let _ = ready_tx.send(Ok(audio_spec));
    let _ = stop_rx.recv();
    drop(stream);
    Ok(audio_spec)
}

fn start_audio_recorder() -> Result<AudioRecorder, String> {
    let samples = Arc::new(Mutex::new(Vec::<i16>::new()));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    let capture = Arc::clone(&samples);
    let join = thread::spawn(move || {
        let result = capture_audio_thread(capture, stop_rx, ready_tx.clone());
        if let Err(error) = &result {
            let _ = ready_tx.send(Err(error.clone()));
        }
        result
    });
    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(_)) => Ok(AudioRecorder {
            samples,
            stop_tx,
            join: Some(join),
        }),
        Ok(Err(error)) => {
            let _ = join.join();
            Err(error)
        }
        Err(error) => {
            let _ = stop_tx.send(());
            let _ = join.join();
            Err(format!("Microphone startup timed out: {error}"))
        }
    }
}

fn stop_audio_recorder(mut recorder: AudioRecorder) -> Result<(Vec<i16>, AudioSpec), String> {
    let _ = recorder.stop_tx.send(());
    let join = recorder
        .join
        .take()
        .ok_or_else(|| "Recorder thread was already stopped.".to_string())?;
    let spec = join
        .join()
        .map_err(|_| "The microphone thread stopped unexpectedly.".to_string())??;
    let samples = recorder
        .samples
        .lock()
        .map_err(|_| "Audio buffer was poisoned.".to_string())?
        .clone();
    Ok((samples, spec))
}

fn write_wav(path: &Path, samples: Vec<i16>, spec: AudioSpec) -> Result<u64, String> {
    if samples.is_empty() {
        return Err("No microphone samples were captured.".into());
    }
    let spec = hound::WavSpec {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|error| error.to_string())?;
    for sample in samples.iter().copied() {
        writer
            .write_sample(sample)
            .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())?;
    let frames = samples.len() as u64 / spec.channels.max(1) as u64;
    Ok(frames.saturating_mul(1_000) / spec.sample_rate.max(1) as u64)
}

#[tauri::command]
fn start_recording(state: State<'_, AppState>) -> Result<(), String> {
    let mut recorder = state
        .recorder
        .lock()
        .map_err(|_| "Recorder state was poisoned.".to_string())?;
    if recorder.is_some() {
        return Err("A recording is already in progress.".into());
    }
    *recorder = Some(start_audio_recorder()?);
    Ok(())
}

#[tauri::command]
fn stop_recording(state: State<'_, AppState>) -> Result<RecordingInfo, String> {
    let recorder = state
        .recorder
        .lock()
        .map_err(|_| "Recorder state was poisoned.")?
        .take()
        .ok_or_else(|| "There is no active recording.".to_string())?;
    let id = Uuid::new_v4().to_string();
    let recordings_dir = state.data_dir.join("recordings");
    fs::create_dir_all(&recordings_dir).map_err(|error| error.to_string())?;
    let path = recordings_dir.join(format!("{id}.wav"));
    let (samples, spec) = stop_audio_recorder(recorder)?;
    let duration_ms = write_wav(&path, samples, spec)?;
    Ok(RecordingInfo {
        id,
        path: path.to_string_lossy().into_owned(),
        duration_ms,
    })
}

#[tauri::command]
fn cancel_recording(state: State<'_, AppState>) -> Result<(), String> {
    let recorder = state
        .recorder
        .lock()
        .map_err(|_| "Recorder state was poisoned.")?
        .take();
    if let Some(recorder) = recorder {
        let _ = stop_audio_recorder(recorder);
    }
    Ok(())
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<AppConfig, String> {
    Ok(state
        .config
        .lock()
        .map_err(|_| "Settings state was poisoned.")?
        .clone())
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppConfig,
) -> Result<AppConfig, String> {
    let mut current = state
        .config
        .lock()
        .map_err(|_| "Settings state was poisoned.")?;
    let mut sanitized = settings;
    sanitized.mode = if sanitized.mode == "toggle" {
        "toggle".into()
    } else {
        "hold".into()
    };
    sanitized.provider = match sanitized.provider.as_str() {
        "openai" | "groq" => sanitized.provider.clone(),
        _ => "local".into(),
    };
    sanitized.max_duration_seconds = sanitized.max_duration_seconds.clamp(15, 900);
    sanitized.cloud_credit_limit = sanitized.cloud_credit_limit.min(100_000);
    sanitized.whisper_binary = sanitized.whisper_binary.trim().to_string();
    sanitized.whisper_model = sanitized.whisper_model.trim().to_string();
    sanitized.vocabulary = sanitized
        .vocabulary
        .into_iter()
        .map(|word| word.trim().to_string())
        .filter(|word| !word.is_empty())
        .take(100)
        .collect();
    sanitized.cloud_minutes_used = current.cloud_minutes_used;
    update_global_hotkey(&app, &current, &sanitized)?;
    let launch_at_login_changed = current.launch_at_login != sanitized.launch_at_login;
    if launch_at_login_changed {
        if let Err(error) = configure_launch_at_login(sanitized.launch_at_login) {
            let _ = update_global_hotkey(&app, &sanitized, &current);
            return Err(error);
        }
    }
    if let Err(error) = state.save_config(&sanitized) {
        if launch_at_login_changed {
            let _ = configure_launch_at_login(current.launch_at_login);
        }
        let _ = update_global_hotkey(&app, &sanitized, &current);
        return Err(error);
    }
    *current = sanitized.clone();
    Ok(sanitized)
}

#[tauri::command]
fn get_jobs(state: State<'_, AppState>) -> Result<Vec<JobRecord>, String> {
    let mut jobs = state.load_jobs();
    let mut recovered = false;
    for job in &mut jobs {
        if job.status == "processing" {
            job.status = "queued".into();
            job.error = "Recovered after the app restarted before delivery.".into();
            recovered = true;
        }
    }
    if recovered {
        state.save_jobs(&jobs)?;
    }
    Ok(jobs)
}

#[tauri::command]
fn enqueue_recording(
    state: State<'_, AppState>,
    recording: RecordingInfo,
) -> Result<JobRecord, String> {
    if !Path::new(&recording.path).exists() {
        return Err("The recorded audio file is missing.".into());
    }
    let job = JobRecord {
        id: recording.id,
        created_at: now_millis(),
        status: "queued".into(),
        audio_path: recording.path,
        duration_ms: recording.duration_ms,
        transcript: String::new(),
        error: String::new(),
        attempts: 0,
    };
    update_job(&state, job)
}

fn basic_cleanup(input: &str) -> String {
    let fillers = ["um", "uh", "erm", "hmm", "like", "basically"];
    let mut output: Vec<String> = Vec::new();
    for token in input.split_whitespace() {
        let clean = token.trim_matches(|character: char| ",".contains(character));
        if fillers
            .iter()
            .any(|filler| clean.eq_ignore_ascii_case(filler))
        {
            continue;
        }
        if output
            .last()
            .map(|last| last.eq_ignore_ascii_case(clean))
            .unwrap_or(false)
        {
            continue;
        }
        output.push(token.to_string());
    }
    let mut text = output.join(" ").trim().to_string();
    if text.is_empty() {
        return text;
    }
    if !matches!(text.chars().last(), Some('.') | Some('!') | Some('?')) {
        text.push('.');
    }
    let mut characters = text.chars();
    if let Some(first) = characters.next() {
        text = first.to_uppercase().collect::<String>() + characters.as_str();
    }
    text
}

async fn transcribe_local(config: &AppConfig, job: &JobRecord) -> Result<String, String> {
    let model = if config.whisper_model.trim().is_empty() {
        env_value("WHISPER_MODEL").ok_or_else(|| {
            "Local mode needs a Whisper.cpp model path. Set it in .env or settings.json."
                .to_string()
        })?
    } else {
        config.whisper_model.trim().to_string()
    };
    let binary = if config.whisper_binary.trim().is_empty() {
        env_or_config("WHISPER_BINARY", "whisper-cli")
    } else {
        config.whisper_binary.trim().to_string()
    };
    let output_prefix = format!("{}.transcript", job.audio_path);
    let mut command = Command::new(&binary);
    command
        .arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&job.audio_path)
        .arg("-otxt")
        .arg("-of")
        .arg(&output_prefix)
        .arg("-nt");
    if config.language != "auto" && !config.language.is_empty() {
        command.arg("-l").arg(&config.language);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = command
        .output()
        .await
        .map_err(|error| format!("Could not launch Whisper.cpp: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Whisper.cpp could not transcribe this recording.".into()
        } else {
            stderr
        });
    }
    let text_path = PathBuf::from(format!("{output_prefix}.txt"));
    let text = fs::read_to_string(&text_path)
        .unwrap_or_else(|_| String::from_utf8_lossy(&output.stdout).into_owned());
    let _ = fs::remove_file(text_path);
    if text.trim().is_empty() {
        return Err("Whisper.cpp returned an empty transcript.".into());
    }
    Ok(text.trim().to_string())
}

async fn transcribe_remote(config: &AppConfig, job: &JobRecord) -> Result<String, String> {
    let provider = config.provider.as_str();
    let (key_name, model) = match provider {
        "groq" => ("GROQ_API_KEY", "whisper-large-v3-turbo"),
        "openai" => ("OPENAI_API_KEY", "whisper-1"),
        _ => return Err(format!("Unsupported transcription provider: {provider}")),
    };
    let key = env::var(key_name).map_err(|_| format!("{key_name} is not configured."))?;
    let endpoint = match provider {
        "groq" => "https://api.groq.com/openai/v1/audio/transcriptions",
        _ => "https://api.openai.com/v1/audio/transcriptions",
    };
    let bytes = fs::read(&job.audio_path).map_err(|error| error.to_string())?;
    let part = Part::bytes(bytes)
        .file_name("dictation.wav")
        .mime_str("audio/wav")
        .map_err(|error| error.to_string())?;
    let mut form = Form::new()
        .part("file", part)
        .text("model", model.to_string());
    if config.language != "auto" && !config.language.is_empty() {
        form = form.text("language", config.language.clone());
    }
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Transcription request failed: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid transcription response: {error}"))?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
            .unwrap_or("The transcription provider rejected the request.")
            .into());
    }
    body.get("text")
        .and_then(|text| text.as_str())
        .filter(|text| !text.trim().is_empty())
        .map(|text| text.trim().into())
        .ok_or_else(|| "The transcription provider returned no text.".into())
}

async fn cleanup_remote(config: &AppConfig, text: &str) -> Result<String, String> {
    // Never reuse a transcription key for cleanup. This keeps the default local
    // flow zero-cost and makes a second paid request an explicit opt-in.
    let key = env::var("LLM_API_KEY")
        .map_err(|_| "No explicit LLM_API_KEY is configured; using local cleanup.".to_string())?;
    let endpoint = env_or_config("LLM_BASE_URL", "https://api.openai.com/v1/chat/completions");
    let model = env_or_config("LLM_MODEL", "gpt-4o-mini");
    let vocabulary = if config.vocabulary.is_empty() {
        "(none)".to_string()
    } else {
        config.vocabulary.join(", ")
    };
    let style = match config.style.as_str() {
        "casual" => "casual message",
        "formal" => "professional",
        "code" => "technical/code",
        _ => "natural",
    };
    let system = format!("Rewrite speech into polished {style} writing. Preserve the exact meaning. Remove filler words, false starts, and accidental repetitions. Honor explicit corrections such as actually and I mean. Preserve names, numbers, URLs, acronyms, code, and technical terms. Never summarize, invent facts, or add information. The speaker's vocabulary includes: {vocabulary}. {} Return only the final text.", config.profile_notes);
    let payload = json!({
        "model": model,
        "temperature": 0.1,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ]
    });
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Cleanup request failed: {error}"))?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid cleanup response: {error}"))?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
            .unwrap_or("The cleanup provider rejected the request.")
            .into());
    }
    body.get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .filter(|content| !content.trim().is_empty())
        .map(|content| content.trim().into())
        .ok_or_else(|| "The cleanup provider returned no text.".into())
}

async fn process_job_internal(state: &AppState, job_id: &str) -> Result<JobRecord, String> {
    let mut job = state
        .load_jobs()
        .into_iter()
        .find(|item| item.id == job_id)
        .ok_or_else(|| "Queued recording was not found.".to_string())?;
    if job.status == "completed" {
        return Ok(job);
    }
    let config = state
        .config
        .lock()
        .map_err(|_| "Settings state was poisoned.")?
        .clone();
    if config.provider != "local" {
        let minutes = ((job.duration_ms.saturating_add(59_999)) / 60_000) as u32;
        if config.cloud_minutes_used.saturating_add(minutes) > config.cloud_credit_limit {
            job.status = "queued".into();
            job.error = format!(
                "Cloud guardrail reached: {} of {} minutes used.",
                config.cloud_minutes_used, config.cloud_credit_limit
            );
            update_job(state, job.clone())?;
            return Ok(job);
        }
    }
    job.status = "processing".into();
    job.attempts = job.attempts.saturating_add(1);
    job.error.clear();
    update_job(state, job.clone())?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    state
        .running_jobs
        .lock()
        .map_err(|_| "Job state was poisoned.")?
        .insert(job.id.clone(), cancel_tx);
    let transcription = async {
        match config.provider.as_str() {
            "local" => transcribe_local(&config, &job).await,
            "openai" | "groq" => transcribe_remote(&config, &job).await,
            _ => Err("Unknown transcription provider.".into()),
        }
    };
    let result = tokio::select! {
        _ = &mut cancel_rx => Err("Cancelled by user.".to_string()),
        result = transcription => result,
    };
    state
        .running_jobs
        .lock()
        .map_err(|_| "Job state was poisoned.")?
        .remove(&job.id);

    let raw_text = match result {
        Ok(text) => text,
        Err(error) => {
            job.status = "queued".into();
            job.error = error;
            update_job(state, job.clone())?;
            return Ok(job);
        }
    };

    let polished = if config.cleanup_enabled {
        match cleanup_remote(&config, &raw_text).await {
            Ok(text) => text,
            Err(_) => basic_cleanup(&raw_text),
        }
    } else {
        raw_text.trim().to_string()
    };
    if polished.is_empty() {
        job.status = "queued".into();
        job.error = "The transcript was empty.".into();
        update_job(state, job.clone())?;
        return Ok(job);
    }

    job.status = "completed".into();
    job.transcript = polished;
    job.error.clear();
    if config.provider != "local" {
        let minutes = ((job.duration_ms.saturating_add(59_999)) / 60_000) as u32;
        let mut current = state
            .config
            .lock()
            .map_err(|_| "Settings state was poisoned.")?;
        let mut updated = current.clone();
        updated.cloud_minutes_used = updated.cloud_minutes_used.saturating_add(minutes);
        state.save_config(&updated)?;
        *current = updated;
    }
    if !config.retain_raw_audio {
        let _ = fs::remove_file(&job.audio_path);
    }
    update_job(state, job.clone())?;
    Ok(job)
}

#[tauri::command]
async fn process_job(state: State<'_, AppState>, job_id: String) -> Result<JobRecord, String> {
    process_job_internal(&state, &job_id).await
}

#[tauri::command]
async fn retry_pending_jobs(state: State<'_, AppState>) -> Result<Vec<JobRecord>, String> {
    let pending = state
        .load_jobs()
        .into_iter()
        .filter(|job| job.status == "queued" || job.status == "processing")
        .map(|job| job.id)
        .collect::<Vec<_>>();
    for job_id in pending {
        let _ = process_job_internal(&state, &job_id).await?;
    }
    Ok(state.load_jobs())
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    if let Some(sender) = state
        .running_jobs
        .lock()
        .map_err(|_| "Job state was poisoned.")?
        .remove(&job_id)
    {
        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
fn delete_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let mut jobs = state.load_jobs();
    if let Some(job) = jobs.iter().find(|item| item.id == job_id) {
        let _ = fs::remove_file(&job.audio_path);
    }
    jobs.retain(|job| job.id != job_id);
    state.save_jobs(&jobs)
}

#[tauri::command]
fn insert_text(text: String, restore_clipboard: bool) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let mut clipboard =
        Clipboard::new().map_err(|error| format!("Clipboard unavailable: {error}"))?;
    let previous = clipboard.get_text().ok();
    clipboard
        .set_text(text)
        .map_err(|error| format!("Could not write clipboard: {error}"))?;
    let mut enigo = Enigo::new(&EnigoSettings::default())
        .map_err(|error| format!("Keyboard automation unavailable: {error}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|error| error.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|error| error.to_string())?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|error| error.to_string())?;

    if restore_clipboard {
        if let Some(previous) = previous {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(900));
                if let Ok(mut clipboard) = Clipboard::new() {
                    let _ = clipboard.set_text(previous);
                }
            });
        }
    }
    Ok(())
}

fn register_initial_hotkey(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    if !config.enabled {
        return Ok(());
    }
    let shortcut = shortcut_from_string(&config.hotkey)?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|error| error.to_string())
}

fn update_global_hotkey(
    app: &AppHandle,
    current: &AppConfig,
    next: &AppConfig,
) -> Result<(), String> {
    if current.enabled == next.enabled && current.hotkey == next.hotkey {
        return Ok(());
    }
    let old_shortcut = if current.enabled {
        shortcut_from_string(&current.hotkey).ok()
    } else {
        None
    };
    let new_shortcut = if next.enabled {
        Some(shortcut_from_string(&next.hotkey)?)
    } else {
        None
    };

    // Register first so a conflict leaves the old shortcut available for retry.
    if let Some(shortcut) = new_shortcut {
        app.global_shortcut()
            .register(shortcut)
            .map_err(|error| error.to_string())?;
    }
    if let Some(shortcut) = old_shortcut {
        let _ = app.global_shortcut().unregister(shortcut);
    }
    Ok(())
}

fn configure_launch_at_login(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let (run_key, _) = current_user
            .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
            .map_err(|error| error.to_string())?;
        let value_name = "DictationLab";
        if enabled {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let command = format!(
                "\"{}\" --launch-at-login",
                executable.to_string_lossy().replace('"', "\\\"")
            );
            run_key
                .set_value(value_name, &command)
                .map_err(|error| error.to_string())?;
        } else {
            let _ = run_key.delete_value(value_name);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        if enabled {
            Err("Launch at login is implemented for Windows builds.".into())
        } else {
            Ok(())
        }
    }
}

#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    configure_launch_at_login(enabled)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "Show Dictation Lab", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Toggle dictation", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &toggle_item, &quit_item])?;
    let mut pixels = vec![0_u8; 16 * 16 * 4];
    for y in 0..16 {
        for x in 0..16 {
            let dx = x as i32 - 7;
            let dy = y as i32 - 7;
            if dx * dx + dy * dy <= 49 {
                let offset = ((y * 16 + x) * 4) as usize;
                let dark_center = dx.abs() <= 2 && dy.abs() <= 2;
                pixels[offset..offset + 4].copy_from_slice(if dark_center {
                    &[34, 36, 33, 255]
                } else {
                    &[214, 240, 109, 255]
                });
            }
        }
    }
    let icon = tauri::image::Image::new_owned(pixels, 16, 16);
    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "toggle" => {
                let _ = app.emit("tray-toggle", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn build_state(app: &AppHandle) -> Result<AppState, String> {
    let data_dir = app_data_dir(app)?;
    fs::create_dir_all(data_dir.join("recordings")).map_err(|error| error.to_string())?;
    Ok(AppState {
        config: Mutex::new(AppState::load_config(&data_dir)),
        data_dir,
        recorder: Mutex::new(None),
        running_jobs: Mutex::new(HashMap::new()),
    })
}

fn main() {
    load_environment();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    let state = match event.state {
                        ShortcutState::Pressed => "pressed",
                        ShortcutState::Released => "released",
                    };
                    let _ = app.emit(
                        "global-hotkey",
                        HotkeyEvent {
                            state: state.into(),
                        },
                    );
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let state = build_state(&app.handle()).map_err(std::io::Error::other)?;
            let config = state
                .config
                .lock()
                .map_err(|_| std::io::Error::other("Settings state was poisoned."))?
                .clone();
            #[cfg(target_os = "windows")]
            {
                if let Err(error) = configure_launch_at_login(config.launch_at_login) {
                    eprintln!("Could not synchronize launch-at-login: {error}");
                }
            }
            app.manage(state);
            if let Err(error) = register_initial_hotkey(&app.handle(), &config) {
                eprintln!(
                    "Global shortcut is unavailable; choose another shortcut in Settings: {error}"
                );
            }
            setup_tray(app)?;
            if !env::args().any(|argument| argument == "--launch-at-login") {
                show_main_window(&app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            cancel_recording,
            get_settings,
            save_settings,
            get_jobs,
            enqueue_recording,
            process_job,
            retry_pending_jobs,
            cancel_job,
            delete_job,
            insert_text,
            set_launch_at_login
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dictation Lab");
}
