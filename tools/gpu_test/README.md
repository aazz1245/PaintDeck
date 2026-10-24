# 顯示卡／安裝精靈測試小工具（HANDOFF 第五十一筆）

在這台 N 卡電腦上，用假的顯示卡清單測安裝精靈的 A 卡、Intel、沒有顯示卡、偵測失敗流程。都用 Git Bash 跑；Python 用 `C:\Users\User\AppData\Local\Python\bin\python -I -X utf8`。

- `fake\*.json`：`ANIMA_FAKE_GPUS` 用的假 WMI 結果（RX 6700 XT、780M、RX 5700、RX 580、Arc B580、UHD 770、沒有顯示卡）。偵測失敗用字串 `fail`。
- `start_srv.sh <anima-server.exe> <port> <名字> [假顯示卡 json | fail]`：開一個隔離測試站，資料在 `%TEMP%\anima_apitest\a51\<名字>\`，comfy.json 各站分開；下載一律指到沒人聽的 `127.0.0.1:8609`（不會真的抓 ComfyUI、模型；pip 不受影響）。
  - 先把 `src-tauri\target\debug\anima-server.exe` 複製到別處再開（不然 cargo 編譯時檔案被鎖）。
  - `COMFY_ROOT` 寫死指到 `%TEMP%\anima_apitest\amd\nv\comfy_fake\ComfyUI`（第五十筆做的假 ComfyUI）；不在了就改成任何一個假的 ComfyUI 資料夾。
- `wiz51.py`：`scan`／`check`／`runitems`（開始安裝、列項目、馬上取消）／`run`（裝到結束，看 pip 進度）／`diff`（新舊版 JSON 比對，只比舊版有的欄位）。
- `sum51.py 名字:port …  [--gpu amd --gfx gfx1031] [--packs pe]`：一次看每一站的偵測、自動判斷、要下載什麼、安裝項目、存下來的 comfy.json。

用完記得關掉測試站（只關 `anima_apitest` 底下的 anima-server.exe）。
