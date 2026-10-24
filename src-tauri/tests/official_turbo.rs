//! 官方 Qwen-Image-2.1-Turbo（2026-10-09 發布）：要用官方 8 步排程，不能套 Noct Q Turbo（Viggle）依尺寸位移的排程。
use anima_app::graphs;
use serde_json::{json, Value};

const OFFICIAL: &str =
    "1.000000, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0.000000";

fn nodes(p: Value) -> Vec<Value> {
    let (n, _) = graphs::build(&p, std::path::Path::new("."), 0).unwrap();
    n.into_iter().map(|(_, v)| v).collect()
}

fn sigmas(n: &[Value]) -> Option<String> {
    n.iter()
        .find(|v| v["class_type"] == "ManualSigmas")
        .map(|v| v["inputs"]["sigmas"].as_str().unwrap().to_string())
}

fn base(model: &str) -> Value {
    json!({"model": model, "family": "qwen21", "mode": "txt2img", "prompt": "A woman.", "negative": "",
           "seed": 1, "width": 1024, "height": 1024, "steps": 8, "cfg": 1, "sampler": "euler", "scheduler": "simple"})
}

#[test]
fn official_model_uses_official_sigmas() {
    assert_eq!(
        sigmas(&nodes(base(
            "qwen_image_2.1_turbo_int8_convrot.safetensors"
        )))
        .as_deref(),
        Some(OFFICIAL)
    );
}

#[test]
fn official_lora_on_finetune_uses_official_sigmas() {
    let mut p = base("NoctQ_v4_Base_int8.safetensors");
    p["loras"] = json!([{"name": "qwen21\\qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors", "strength": 1.0}]);
    let n = nodes(p.clone());
    assert_eq!(sigmas(&n).as_deref(), Some(OFFICIAL));
    assert!(n.iter().any(|v| v["class_type"] == "LoraLoaderModelOnly"));
    // 關掉 LoRA 就回到一般取樣
    p["loras"][0]["enabled"] = json!(false);
    let n = nodes(p);
    assert_eq!(sigmas(&n), None);
    assert!(n.iter().any(|v| v["class_type"] == "KSampler"));
}

#[test]
fn noct_turbo_keeps_viggle_schedule() {
    let s = sigmas(&nodes(base("NoctQ_v3_Turbo_int8.safetensors"))).unwrap();
    assert_eq!(s, graphs::turbo_sigmas(1024, 1024, 1.0));
    assert_ne!(s, OFFICIAL);
}

#[test]
fn official_sigmas_for_img2img() {
    assert_eq!(
        graphs::official_turbo_sigmas(0.6),
        "0.600000, 0.414568, 0.000000"
    );
    assert_eq!(
        graphs::official_turbo_sigmas(0.9),
        "0.900000, 0.895080, 0.845148, 0.704534, 0.414568, 0.000000"
    );
}

#[test]
fn pose_control_adds_two_controlnets() {
    let mut p = base("qwen_image_2.1_turbo_int8_convrot.safetensors");
    p["pose_control"] = json!({"depth": "doggy_style_depth.png", "pose": "doggy_style_pose.png"});
    let n = nodes(p);
    let cn: Vec<&Value> = n
        .iter()
        .filter(|v| v["class_type"] == "ZImageFunControlnet")
        .collect();
    assert_eq!(cn.len(), 2);
    assert_eq!(
        n.iter()
            .filter(|v| v["class_type"] == "ModelPatchLoader")
            .count(),
        1
    );
    assert!(n.iter().any(|v| v["class_type"] == "LoadImage"
        && v["inputs"]["image"] == "anima_pose/doggy_style_depth.png"));
    // Anima 家族不吃這個
    let mut a = json!({"model": "anima-turbo-v1.1.safetensors", "family": "anima", "mode": "txt2img", "prompt": "a", "negative": "",
                       "seed": 1, "width": 832, "height": 1216, "steps": 8, "cfg": 1, "sampler": "euler", "scheduler": "simple"});
    a["pose_control"] = json!({"depth": "x.png"});
    assert!(!nodes(a)
        .iter()
        .any(|v| v["class_type"] == "ZImageFunControlnet"));
}
