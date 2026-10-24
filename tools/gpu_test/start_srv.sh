#!/bin/bash
# 開一個隔離測試站：start_srv.sh <anima-server.exe> <port> <名字> [假顯示卡 json 檔 | fail]
# 每個測試站有自己的資料夾（%TEMP%\anima_apitest\a51\<名字>），comfy.json 跟著 cfg\config.json 放，互不影響。
# 下載一律指到沒人聽的假鏡像（127.0.0.1:8609），不會真的從網路抓 ComfyUI、模型；pip 不受影響
BIN="$1"; PORT="$2"; NAME="$3"; FAKE="$4"
W="$(cygpath -w "$TEMP")\\anima_apitest\\a51\\$NAME"
U="$(cygpath -u "$W")"
mkdir -p "$U/root" "$U/cfg"
export ANIMA_ROOT="$W\\root"
export ANIMA_PORT="$PORT"
export ANIMA_WEB='D:\AI\anima_app\ui'
export ANIMA_RES='D:\AI\anima_app\resources'
export COMFY_ROOT="$(cygpath -w "$TEMP")\\anima_apitest\\amd\\nv\\comfy_fake\\ComfyUI"
export COMFY_URL="http://127.0.0.1:8181"
export ANIMA_SETUP_CONFIG="$W\\cfg\\config.json"
export ANIMA_STUDIO_PORT=$((PORT + 10000))
export ANIMA_DL_MIRROR="${ANIMA_DL_MIRROR:-http://127.0.0.1:8609}"
if [ -n "$FAKE" ]; then
  if [ "$FAKE" = "fail" ]; then export ANIMA_FAKE_GPUS=fail; else export ANIMA_FAKE_GPUS="$(cat "$FAKE")"; fi
fi
exec "$BIN" > "$U/server.log" 2>&1
