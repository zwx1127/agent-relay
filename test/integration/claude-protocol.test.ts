import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "../../src/providers/agents/claude/driver.ts";
import type { AgentOutputEvent } from "../../src/ports/agent.ts";

const directories: string[] = [];
const drivers: ClaudeDriver[] = [];
afterEach(async () => { await Promise.all(drivers.splice(0).map((driver) => driver.dispose())); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(options: { version?: string; callback?: (event: AgentOutputEvent) => void | Promise<void>; initFail?: boolean; clearHang?: boolean; missingResume?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-claude-")); directories.push(dir);
  const binary = join(dir, process.platform === "win32" ? "claude.cmd" : "claude.js");
  const script = process.platform === "win32" ? join(dir, "claude.js") : binary;
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs'); const readline = require('node:readline'); const crypto = require('node:crypto');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(options.version ?? "2.1.285")} + ' (Claude Code)'); process.exit(0); }
const log = ${JSON.stringify(join(dir, "frames.jsonl"))}; fs.appendFileSync(log, JSON.stringify({argv:process.argv.slice(2)})+'\\n');
let sid = (process.argv.find(a=>a.startsWith('--session-id=') || a.startsWith('--resume=')) || '=' + crypto.randomUUID()).split('=')[1];
let current, scenario, responses=0; const send = f => process.stdout.write(JSON.stringify(f)+'\\n');
const commands = ['clear','compact','context','model','rename','code-review','plugin:scan','slow'].map(name=>({name, description:'Native '+name, argumentHint:'',...(name==='clear'?{aliases:['reset','new']}:{})}));
const result = (fields={}) => send({type:'result',subtype:'success',is_error:false,result:'',session_id:sid,user_message_uuid:current,duration_ms:4,...fields});
const init = () => send({type:'system',subtype:'init',session_id:sid,claude_code_version:'2.1.285',model:'sonnet',permissionMode:'default',slash_commands:commands.map(c=>c.name),capabilities:['interrupt_receipt_v1','interrupt_cancel_queued_v1']});
readline.createInterface({input:process.stdin}).on('line', line => {
 const f = JSON.parse(line); fs.appendFileSync(log,JSON.stringify(f)+'\\n');
 if(f.type==='control_request') {
  if(f.request.subtype==='initialize') {
   if(process.argv.includes('--resume=' + ${JSON.stringify(options.missingResume ?? "none")})) { process.stderr.write('No conversation found with this session ID'); process.exit(1); }
   if(${Boolean(options.initFail)}) { process.stderr.write('Auth error https://login.invalid/?token=secret sk-ant-private'); process.exit(1); }
   send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{commands,models:[{value:'sonnet',displayName:'Sonnet'}],current_permission_mode:'default'}}});
  } else { send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{still_queued:[],cancelled:[]}}}); if(f.request.subtype==='interrupt') result(); }
 } else if(f.type==='user') {
  current=f.uuid; scenario=f.message.content; responses=0; init();
  if(scenario==='text') {
   send({type:'stream_event',session_id:sid,parent_tool_use_id:null,event:{type:'message_start',message:{id:'msg1'}}});
   send({type:'stream_event',session_id:sid,parent_tool_use_id:null,event:{type:'content_block_delta',delta:{type:'text_delta',text:'hello '}}});
   send({type:'stream_event',session_id:sid,parent_tool_use_id:null,event:{type:'content_block_delta',delta:{type:'text_delta',text:'world'}}});
   send({type:'assistant',session_id:sid,uuid:'a1',parent_tool_use_id:null,message:{id:'msg1',content:[{type:'text',text:'hello world'},{type:'tool_use',id:'tool1',name:'Read',input:{file_path:'README.md'}}]}});
   send({type:'user',session_id:sid,parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:'tool1',content:'private tool output'}]}});
   result({result:'hello world'});
  } else if(scenario==='approve' || scenario==='question' || scenario==='cancelprompt' || scenario==='conflict' || scenario==='approvalpair') {
   const req = {type:'control_request',request_id:'permit',request:{subtype:'can_use_tool',tool_name:scenario==='question'?'AskUserQuestion':'Bash',tool_use_id:'tool-permission',input:scenario==='question'?{questions:[{question:'Select sections?',header:'Sections',multiSelect:true,options:[{label:'Intro',description:'Start'},{label:'End',description:'Finish'}]}]}:{command:'npm test'},title:'Native permission title',default_to_no:true,suppress_always_allow_rule:true,decision_reason:'Native approval reason'}};
   send(req); send(req);
   if(scenario==='approvalpair') send({...req,request_id:'permit2',request:{...req.request,input:{command:'npm run lint'}}});
   if(scenario==='conflict') send({...req, request:{...req.request,input:{command:'changed action'}}});
   if(scenario==='cancelprompt') setTimeout(()=>{send({type:'control_cancel_request',request_id:'permit'});result();},15);
  } else if(scenario==='unsupported') { send({type:'control_request',request_id:'unknown',request:{subtype:'future_sensitive_operation'}}); }
  else if(scenario==='elicitation') send({type:'control_request',request_id:'mcp1',request:{subtype:'elicitation',mcp_server_name:'test',mode:'form',message:'Configure',requested_schema:{type:'object',properties:{name:{type:'string'}},required:['name']}}});
  else if(scenario==='failure') result({subtype:'error_during_execution',is_error:true,errors:['rate limited']});
  else if(scenario==='crash') process.exit(2);
  else if(scenario==='malformed') process.stdout.write('not json\\n');
  else if(scenario==='/clear' || scenario==='/reset') {if(!${Boolean(options.clearHang)}) {send({type:'conversation_reset',session_id:sid});sid=crypto.randomUUID();init();result();}}
  else if(scenario==='warning') {send({type:'system',subtype:'warning',message:'auth=Bearer fixture_secret {"token":"fixture_secret"} ANTHROPIC_API_KEY=fixture_secret'});result();}
  else if(scenario==='stale') { result({user_message_uuid:'61791edc-01e7-4dbd-8d8f-4ecdf0d16cd1',session_id:'61791edc-01e7-4dbd-8d8f-4ecdf0d16cd1'}); }
  else if(scenario==='commands') {send({type:'system',subtype:'commands_changed',session_id:sid,commands:[{name:'new-skill',description:'Loaded dynamically'}]});result();}
  else if(scenario==='slow' || scenario==='/slow') {}
  else result({result:'native result'});
 } else if(f.type==='control_response') { responses++; if(scenario!=='approvalpair'||responses===2) result({result:'decision received'}); }
});
`);
  if (process.platform === "win32") writeFileSync(binary, `@echo off\r\n"${process.execPath}" "%~dp0claude.js" %*\r\n`);
  else chmodSync(binary, 0o755);
  const events: AgentOutputEvent[] = []; const exits: unknown[] = [];
  const driver = new ClaudeDriver({ claudeBin: binary, controlTimeoutMs: 1000 }, (event) => { events.push(event); return options.callback?.(event); }, (event) => { exits.push(event); });
  drivers.push(driver);
  return { driver, events, exits, dir, log: () => readFileSync(join(dir, "frames.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}
async function until(predicate: () => boolean) {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > until) throw new Error("Fixture timed out"); await new Promise((r) => setTimeout(r, 5)); }
}
const startOptions = { conversationId: 9, workspaceName: "demo", workspacePath: process.cwd() };

describe("Claude native CLI stream-json integration", () => {
  test("uses native configuration and safe flags with a real initialization exchange", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions);
    expect(status.sessionKey).toBe("claude:9:demo"); expect(status.appServerVersion).toBe("2.1.285");
    const args: string[] = f.log()[0].argv;
    expect(args).toContain("stdio"); expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("--dangerously-skip-permissions"); expect(args).not.toContain("--allowedTools"); expect(args).not.toContain("--bare");
    expect((await f.driver.listNativeCommands(status.sessionKey)).some((c) => c.command === "/plugin:scan")).toBe(true);
    expect(await f.driver.listModels()).toMatchObject([{ id: "sonnet" }]);
  });
  test("streams root text once, emits tools, and completes turns without exiting the CLI", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); const sent = await f.driver.send(status.sessionKey, "text");
    await until(() => f.events.some((e) => e.type === "turn_completed"));
    expect(f.events.flatMap((e) => !e.type || e.type === "message" ? [e.chunk] : []).join("")).toBe("hello world");
    expect(f.events.filter((e) => e.type === "activity")).toMatchObject([{ activity: { status: "started" } }, { activity: { status: "completed" } }]);
    expect(f.driver.getStatus(status.sessionKey)).toMatchObject({ running: true, latestTurn: { id: sent.turnId, status: "completed" } });
    expect(f.exits).toHaveLength(0);
  });
  test("validates permission actions against a live request and never writes allow rules", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "approve");
    await until(() => f.events.some((e) => e.type === "approval_request"));
    const approval = f.events.find((e) => e.type === "approval_request");
    expect(approval).toMatchObject({ title: "Native permission title", params: { default_to_no: true, suppress_always_allow_rule: true } });
    expect(f.events.filter((e) => e.type === "approval_request")).toHaveLength(1);
    await expect(f.driver.respond(status.sessionKey, "permit", { action: "session" })).rejects.toThrow("valid live");
    expect(f.log().filter((e) => e.type === "control_response")).toHaveLength(0);
    await f.driver.respond(status.sessionKey, "permit", { action: "once" });
    await until(() => f.events.some((e) => e.type === "turn_completed"));
    const response = f.log().find((e) => e.type === "control_response").response.response;
    expect(response).toEqual({ behavior: "allow", updatedInput: { command: "npm test" }, toolUseID: "tool-permission" });
    await expect(f.driver.respond(status.sessionKey, "permit", { action: "once" })).rejects.toThrow("expired");
  });
  test("keeps distinct callback IDs for the same tool use independently answerable", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "approvalpair");
    await until(() => f.events.filter((e) => e.type === "approval_request").length === 2);
    expect(f.events.filter((e) => e.type === "approval_request").map((e) => e.type === "approval_request" ? e.approvalId : ""))
      .toEqual(["permit", "permit2"]);
    await f.driver.respond(status.sessionKey, "permit", { action: "once" });
    expect(f.driver.getStatus(status.sessionKey)?.waitingForApproval).toBe(true);
    await f.driver.respond(status.sessionKey, "permit2", { action: "decline" });
    await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.log().filter((e) => e.type === "control_response").map((e) => [e.response.request_id, e.response.response.behavior]))
      .toEqual([["permit", "allow"], ["permit2", "deny"]]);
  });
  test("settles only one racing response to the same live native callback", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "approve");
    await until(() => f.events.some((e) => e.type === "approval_request"));
    const raced = await Promise.allSettled([
      f.driver.respond(status.sessionKey, "permit", { action: "decline" }),
      f.driver.respond(status.sessionKey, "permit", { action: "once" }),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.log().filter((e) => e.type === "control_response")).toHaveLength(1);
    expect(f.log().find((e) => e.type === "control_response").response.response.behavior).toBe("deny");
  });
  test("handles questions, native MCP forms, and denial without losing their schemas", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "question");
    await until(() => f.events.some((e) => e.type === "user_input_request"));
    expect(f.events.find((e) => e.type === "user_input_request")).toMatchObject({ questions: [{ multiSelect: true }] });
    await f.driver.respond(status.sessionKey, "permit", { answers: { "question-0": { answers: ["Intro", "End"] } } });
    await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.log().find((e) => e.type === "control_response").response.response.updatedInput.answers).toEqual({ "Select sections?": ["Intro", "End"] });
    await f.driver.send(status.sessionKey, "elicitation"); await until(() => f.events.some((e) => e.type === "mcp_elicitation_request"));
    await f.driver.respond(status.sessionKey, "mcp1", { action: "decline" }); await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.log().filter((e) => e.type === "control_response").at(-1).response.response).toEqual({ action: "decline" });
  });
  test("invalidates native-cancelled and conflicting approval requests", async () => {
    for (const scenario of ["cancelprompt", "conflict"]) {
      const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, scenario);
      await until(() => f.events.some((e) => e.type === "server_request_resolved"));
      await expect(f.driver.respond(status.sessionKey, "permit", { action: "once" })).rejects.toThrow("expired");
      expect(f.log().some((e) => e.response?.response?.behavior === "allow")).toBe(false);
    }
  });
  test("fails closed for unsupported controls and undeliverable approval UI", async () => {
    const f = fixture({ callback: (event) => { if (event.type === "approval_request") throw new Error("UI unavailable"); } });
    const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "approve");
    await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.log().find((e) => e.type === "control_response").response.response.behavior).toBe("deny");
    await f.driver.send(status.sessionKey, "unsupported"); await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.log().filter((e) => e.type === "control_response").at(-1).response.subtype).toBe("error");
  });
  test("does not block protocol processing on queued Relay output handlers", async () => {
    const f = fixture({ callback: () => new Promise(() => undefined) }); const status = await f.driver.start(startOptions);
    const result = await f.driver.runNativeCommand(status.sessionKey, "/clear");
    expect(result.threadChanged).toBe(true); expect(result.threadId).not.toBe(status.threadId);
  });
  test("times out uncertain clear operations without leaving a wedged native process", async () => {
    const f = fixture({ clearHang: true }); const status = await f.driver.start(startOptions);
    await expect(f.driver.runNativeCommand(status.sessionKey, "/clear")).rejects.toThrow("outcome is unknown");
    expect(f.driver.getStatus(status.sessionKey)?.running ?? false).toBe(false);
    expect((await f.driver.start(startOptions)).running).toBe(true);
  });
  test("native clear, plan and UUID resume keep backend identities separate", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions);
    const clear = await f.driver.runNativeCommand(status.sessionKey, "/clear"); expect(clear.threadChanged).toBe(true);
    expect((await f.driver.listNativeCommands(status.sessionKey)).some((c) => c.command === "/reset")).toBe(true);
    await f.driver.runNativeCommand(status.sessionKey, "/plan");
    expect(f.log().some((e) => e.request?.subtype === "set_permission_mode" && e.request.mode === "plan")).toBe(true);
    const id = "900fe023-b166-45a5-a601-8658023639f8";
    const resumed = await f.driver.runNativeCommand(status.sessionKey, `/resume ${id}`);
    expect(resumed).toMatchObject({ threadId: id, threadChanged: true });
    expect(f.log().filter((e) => e.argv).at(-1).argv).toContain(`--resume=${id}`);
  });
  test("reserves native thread ownership before async startup and releases failed claims", async () => {
    const f = fixture(); const threadId = "900fe023-b166-45a5-a601-8658023639f8";
    const starts = await Promise.allSettled([
      f.driver.start({ ...startOptions, scopeKey: "first", threadId }),
      f.driver.start({ ...startOptions, scopeKey: "second", threadId }),
    ]);
    expect(starts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(starts.filter((r) => r.status === "rejected")).toHaveLength(1);
    const first = starts.find((r) => r.status === "fulfilled");
    if (first?.status === "fulfilled") await f.driver.stop(first.value.sessionKey);
    expect((await f.driver.start({ ...startOptions, scopeKey: "second", threadId })).threadId).toBe(threadId);
  });
  test("restores the previous native session after a failed resume", async () => {
    const missing = "900fe023-b166-45a5-a601-8658023639f8";
    const f = fixture({ missingResume: missing }); const status = await f.driver.start(startOptions);
    await expect(f.driver.runNativeCommand(status.sessionKey, `/resume ${missing}`)).rejects.toThrow("previous Claude session has been restored");
    expect(f.driver.getStatus(status.sessionKey)).toMatchObject({ running: true, threadId: status.threadId });
  });
  test("embeds verified local image bytes and captions as native image blocks without fetching URLs", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions);
    const path = join(f.dir, "screenshot.png"), png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXxoAAAAASUVORK5CYII=", "base64");
    writeFileSync(path, png);
    await f.driver.send(status.sessionKey, "Review this screenshot", { attachments: [{ type: "localImage", path, caption: "Login screen" }] });
    await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.log().find((e) => e.type === "user").message.content).toEqual([
      { type: "text", text: "Review this screenshot" }, { type: "text", text: "Login screen" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
    ]);
    await expect(f.driver.send(status.sessionKey, "remote", { attachments: [{ type: "image", url: "https://example.invalid/private.png" }] })).rejects.toThrow("local images only");
    writeFileSync(path, "not an image");
    await expect(f.driver.send(status.sessionKey, "wrong type", { images: [{ path }] })).rejects.toThrow("image signature");
  });
  test("replaces the catalog dynamically and blocks unknown commands before model dispatch", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "commands");
    await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    const commands = await f.driver.listNativeCommands(status.sessionKey);
    expect(commands.some((c) => c.command === "/new-skill")).toBe(true); expect(commands.some((c) => c.command === "/plugin:scan")).toBe(false);
    const before = f.log().filter((e) => e.type === "user").length;
    await expect(f.driver.runNativeCommand(status.sessionKey, "/unknown")).rejects.toThrow("not in");
    await expect(f.driver.runNativeCommand(status.sessionKey, "/permissions")).rejects.toThrow("local Claude terminal");
    expect(f.log().filter((e) => e.type === "user")).toHaveLength(before);
  });
  test("interrupts via native controls, records errors and expires crashed turns", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "slow");
    await until(() => f.log().some((e) => e.type === "user"));
    await f.driver.interrupt(status.sessionKey); await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.driver.getStatus(status.sessionKey)?.latestTurn?.status).toBe("interrupted");
    await f.driver.send(status.sessionKey, "failure"); await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(f.driver.getStatus(status.sessionKey)?.recentError).toBe("rate limited");
    await f.driver.send(status.sessionKey, "crash"); await until(() => f.exits.length === 1);
    expect(f.driver.getStatus(status.sessionKey)?.running).toBe(false);
  });
  test("ignores late results from another turn and closes malformed transports fail-closed", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); const sent = await f.driver.send(status.sessionKey, "stale");
    await until(() => f.log().some((e) => e.type === "user")); await new Promise((r) => setTimeout(r, 30));
    expect(f.driver.getStatus(status.sessionKey)?.activeTurnId).toBe(sent.turnId);
    expect(f.driver.getStatus(status.sessionKey)?.threadId).toBe(status.threadId);
    await f.driver.interrupt(status.sessionKey); await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    await f.driver.send(status.sessionKey, "malformed"); await until(() => f.exits.length === 1);
    expect(f.driver.getStatus(status.sessionKey)?.running).toBe(false);
  });
  test("rejects old binaries and redacts startup authentication diagnostics", async () => {
    await expect(fixture({ version: "2.1.100" }).driver.start(startOptions)).rejects.toThrow("requires 2.1.280");
    try { await fixture({ initFail: true }).driver.start(startOptions); throw new Error("Expected failure"); }
    catch (error) { expect(String(error)).toContain("Auth error"); expect(String(error)).not.toContain("secret"); expect(String(error)).not.toContain("private"); }
  });
  test("redacts native warning events and stored diagnostics", async () => {
    const f = fixture(); const status = await f.driver.start(startOptions); await f.driver.send(status.sessionKey, "warning");
    await until(() => !f.driver.getStatus(status.sessionKey)?.activeTurnId);
    expect(JSON.stringify(f.events)).not.toContain("fixture_secret");
    expect(f.driver.getStatus(status.sessionKey)?.recentWarning).not.toContain("fixture_secret");
  });
});
