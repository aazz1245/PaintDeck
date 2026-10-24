//! 即時事件廣播：伺服器 → 所有開著的網頁（websocket /ws）。
//! 文字訊息是 JSON（進度、完成的圖、下載進度…），二進位是 ComfyUI 的即時預覽圖。
use crate::py::dumps;
use bytes::Bytes;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone, Debug)]
pub enum Msg {
    Text(Arc<str>),
    Bin(Bytes),
}

#[derive(Clone)]
pub struct Hub(broadcast::Sender<Msg>);

impl Hub {
    pub fn new() -> Hub {
        // 預覽圖很多：網頁太慢跟不上的，舊的直接丟掉（broadcast 會讓落後的接收端跳過）
        Hub(broadcast::channel(256).0)
    }

    pub fn send(&self, v: Value) {
        let _ = self.0.send(Msg::Text(dumps(&v).into()));
    }

    pub fn send_bin(&self, b: Bytes) {
        let _ = self.0.send(Msg::Bin(b));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Msg> {
        self.0.subscribe()
    }
}

impl Default for Hub {
    fn default() -> Self {
        Hub::new()
    }
}
