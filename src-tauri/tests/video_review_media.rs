//! 以合成影像與正弦波驗證選幀／裁切，原始媒體不受改動。
use anima_app::{director, studio::{self,Tools}, video_review};
use std::process::Command;

#[test]
fn synthetic_video_candidates_and_trim_keep_audio_and_original() {
    let Some(ffmpeg)=std::env::var_os("PAINTDECK_TEST_FFMPEG").map(std::path::PathBuf::from) else {
        eprintln!("未設定 PAINTDECK_TEST_FFMPEG，略過合成媒體驗證");return;
    };
    let tools=Tools{node:None,ffprobe:Some(ffmpeg.with_file_name("ffprobe.exe")),ffmpeg:Some(ffmpeg.clone())};
    let dir=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("待刪除").join(format!("film-media-{}",director::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    let source=dir.join("synthetic.mp4");
    let mut c=Command::new(&ffmpeg);
    c.args(["-v","error","-y","-f","lavfi","-i","testsrc2=size=320x240:rate=24:duration=3","-f","lavfi","-i","sine=frequency=440:duration=3","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest"]).arg(&source);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    assert!(c.status().unwrap().success());
    let original=std::fs::read(&source).unwrap();
    let candidates=video_review::extract(&tools,&source,&dir,123).unwrap();
    let list=candidates["candidates"].as_array().unwrap();
    assert_eq!(list.len(),6);
    assert_eq!(list.last().unwrap()["frame"],71);
    for candidate in list {
        let file=dir.join(candidate["file"].as_str().unwrap());
        assert!(file.is_file());assert_eq!(image::image_dimensions(file).unwrap(),(320,240));
    }
    let out=list[1]["trim_out"].as_f64().unwrap();
    let trimmed=dir.join("trimmed.mp4");
    video_review::trim(&tools,&source,&trimmed,out).unwrap();
    let probe=studio::probe(&tools,&trimmed).unwrap();
    assert!(probe.audio);
    assert!((probe.duration-out).abs()<=1.0/24.0+0.01,"duration {} versus {out}",probe.duration);
    assert!(probe.duration<2.5);
    assert_eq!(std::fs::read(&source).unwrap(),original);
    let last=dir.join("last.mp4");
    video_review::trim(&tools,&source,&last,list.last().unwrap()["trim_out"].as_f64().unwrap()).unwrap();
    assert!((studio::probe(&tools,&last).unwrap().duration-3.0).abs()<0.05);
    assert!(video_review::trim(&tools,&source,&dir.join("invalid.mp4"),-1.0).is_err());
    assert!(video_review::trim(&tools,&source,&dir.join("invalid.mp4"),4.0).is_err());
    // 音軌比較長也不能把音軌結尾當作最後影格。
    let longer_audio=dir.join("longer-audio.mp4");
    let mut c=Command::new(&ffmpeg);
    c.args(["-v","error","-y","-f","lavfi","-i","testsrc2=size=320x240:rate=24:duration=3","-f","lavfi","-i","sine=frequency=440:duration=5","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac"]).arg(&longer_audio);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
    assert!(c.status().unwrap().success());
    assert!(studio::probe(&tools,&longer_audio).unwrap().duration>4.9);
    let frames=video_review::extract(&tools,&longer_audio,&dir,124).unwrap();
    assert_eq!(frames["candidates"].as_array().unwrap().last().unwrap()["frame"],71);
    assert!((frames["duration"].as_f64().unwrap()-3.0).abs()<0.01);
}
