# Excel AI 校对 API v1

## 用途

该功能把已经人工整理完成的 `.xlsx` 点名表与一个现有协作会话的日志比对，生成逐字段修改建议。模型只负责识别工作表，不能直接写数据库；只有用户在 WebUI 中勾选并确认的建议才会被原子写入。

管理员可直接在 WebUI **服务器设置 → 服务端 LLM** 配置：

- 接口协议：OpenAI Responses、OpenAI 兼容 Chat Completions 或 Anthropic Messages；
- API Base URL；
- 模型名称和请求超时；
- API Key。该字段只写不回显，使用 `JWT_SECRET` 派生的密钥加密存入 SQLite。

WebUI 保存的密钥优先于 `LLM_API_KEY` 环境变量，配置协议、Base URL、模型和超时后立即对新请求生效，无需重启服务。

## 工作流

1. 浏览器本地解析 `.xlsx`，不把原始文件上传到服务器。
2. `POST /api/v1/sessions/:sessionId/excel-corrections/preview` 发送受限的工作表行数据。
3. 服务端分段调用管理员配置的 LLM，识别 11 个点名记录字段并匹配现有日志。
4. 服务端保存最长 30 分钟的结构化预览，WebUI 展示来源行、旧值、新值、置信度和警告。
5. 用户勾选建议后调用 `POST /api/v1/sessions/:sessionId/excel-corrections/apply`。
6. 服务端先检查所有目标日志版本；任意一条已变化时整批拒绝，不会部分写入。成功更新会进入正常的 `log.updated` 事件流。

## 权限

- 活跃会话：Owner 和 Editor 可生成并应用自己的预览；Viewer 只读。
- 已关闭会话：仅 Owner 可校对。
- 服务端管理员无需成为会话成员，可在管理后台校对任意未删除的活跃或已关闭会话；确认写入会额外生成治理审计记录。
- 预览只能由创建它的账户应用，不能跨会话或跨账户复用。

## 接口

### 能力检查

~~~http
GET /api/v1/sessions/:sessionId/excel-corrections/capabilities
Authorization: Bearer <access-token>
~~~

响应不会包含 API Key 或 Base URL，只返回是否已完整配置、协议、模型、限制和当前用户能否生成预览。

### 生成预览

~~~http
POST /api/v1/sessions/:sessionId/excel-corrections/preview
Authorization: Bearer <access-token>
Content-Type: application/json
~~~

~~~json
{
  "fileName": "2026-08-24点名记录.xlsx",
  "utcOffsetMinutes": 480,
  "sheets": [
    {
      "name": "点名记录",
      "rows": [
        { "rowNumber": 2, "cells": ["#", "时间", "呼号", "RST发", "RST收", "QTH"] },
        { "rowNumber": 3, "cells": ["1", "20:01", "BG5ABC", "59", "57", "杭州"] }
      ]
    }
  ]
}
~~~

服务端最多接受 5 个工作表、1000 个非空行、每行 30 列、每个单元格 500 个字符及合计 200000 个字符。原始工作簿和完整提示词不会持久化。

### 应用人工选择的建议

~~~http
POST /api/v1/sessions/:sessionId/excel-corrections/apply
Authorization: Bearer <access-token>
Idempotency-Key: <unique-id>
Content-Type: application/json
~~~

~~~json
{
  "previewId": "<preview-id>",
  "proposalIds": ["<proposal-id>"]
}
~~~

应用接口具有幂等语义。预览过期、已使用、目标日志版本发生变化，或建议不属于该预览时，请重新生成预览。

## 提示词与数据边界

系统提示词明确区分主控分段行与来台记录、RST 发与 RST 收、时间、呼号、QTH、设备、功率、天线、高度和备注。工作表所有内容都按不可信数据处理，单元格中的指令只能作为表格文字，不能改变输出规则。缺少整列时保留服务器旧值；表中明确存在但留空的可选字段才会建议清空。
