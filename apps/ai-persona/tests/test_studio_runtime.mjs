import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSummary} from '../src/ai_persona/static/studio-runtime.mjs';

test('incompatible prompts have an actionable explanation alongside the completed trigger', () => {
  const text = runtimeSummary({type:'learning',status:'failed',triggered:true,review:{total:0},runtime:{error_code:'incompatible'}},{failed:'运行失败'});
  assert.match(text, /提示词版本与当前程序不一致/);
  assert.match(text, /更新服务后重试/);
  assert.match(text, /本轮触发学习/);
  assert.doesNotMatch(text, /处理遇到异常/);
});
