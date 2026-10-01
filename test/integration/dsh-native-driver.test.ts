import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshDriver } from "../../src/providers/agents/dsh/driver.ts";
import type { AgentMessageOutputEvent, AgentOutputEvent, AgentExitEvent, AgentApprovalRequestEvent, AgentUserInputRequestEvent } from "../../src/ports/agent.ts";
import { writeNodeCommand } from "../support/codex-app-server-harness.ts";

const fixture = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(process.env.DSH_FAKE_VERSION || '0.2.0-rc.2'); process.exit(0); }
const log = process.env.DSH_FAKE_LOG;
const token = 'fixture-launch-secret';
const cookie = 'fixture-cookie-secret';
const sessions = new Map(); const clients = new Set(); const pending = new Map();
let next = 0, connections = 0;
function write(value) { fs.appendFileSync(log, JSON.stringify(value)+'\\n'); }
function event(session, type, data) {
 const e={seq:session.events.length,time:Date.now(),type,data}; session.events.push(e);
 for(const ws of clients) for(const [streamId,stream] of ws.data.streams) if(stream.endpoint==='session/follow'&&stream.id===session.id) ws.send(JSON.stringify({type:'item',streamId,value:{type:'event',event:e}}));
}
function global(value) { for(const ws of clients) for(const [streamId,stream] of ws.data.streams) if(stream.endpoint==='$events') ws.send(JSON.stringify({type:'item',streamId,value})); }
function done(session, kind='completed') { event(session,'turn/end',{turn:session.turn,reason:kind==='error'?{kind,error:{message:'fixture failure'}}:{kind}}); session.running=false; }
function answer(session, message='Native answer') { event(session,'assistant/message',{turn:session.turn,step:0,message:{id:'message-'+session.turn,content:[{type:'text',text:message}]}}); done(session); }
function ask(session, kind, commandResolve) {
 const eventId='event-'+(++next); const request=kind==='approval/request'?{toolName:'bash',callId:'tool-1',reason:'Run the test command once?'}:{questions:[{id:'choice',header:'Choose',question:'Which option?',detail:'Native detail',multiSelect:true,options:[{label:'One',description:'First'},{label:'Two'}]}]};
 pending.set(eventId,{session,kind,commandResolve,request}); global({type:'waterfall',event:kind,eventId,agentId:session.id,request}); return eventId;
}
function projections(s) { return {asOfSeq:s.events.length-1,values:{title:'Native '+s.id,modelSelection:{next:{provider:'configured-provider',model:'configured-model'}},permissions:{currentValue:'workspace-write'},imageLimits:{maxImageBytes:1048576,maxImagesPerMessage:4,maxMessageImageBytes:2097152,mediaTypes:['image/png','image/jpeg','image/webp','image/gif']},userQuestions:{active:s.continued?[{callId:'timed-call',state:'continued',questions:[{id:'late',question:'Later answer?',options:[{label:'Yes'},{label:'No'}]}]}]:[]}}}; }
const server=Bun.serve({hostname:'127.0.0.1',port:0,
 async fetch(req,server) {
  const url=new URL(req.url);
  if(url.pathname==='/') {
    if(url.searchParams.get('token')!==token) return new Response('',{status:401});
    return new Response(null,{status:302,headers:{'set-cookie':'dsh='+cookie+'; HttpOnly; SameSite=Strict','location':process.env.DSH_FAKE_REDIRECT?'https://example.invalid/':'/'}});
  }
  if(req.headers.get('cookie')!=='dsh='+cookie || req.headers.get('origin')!==server.url.origin) return new Response('unauthorized',{status:401});
  if(url.pathname==='/api/remote.mux') return server.upgrade(req,{data:{streams:new Map(),client:'client-'+(++connections)}})?undefined:new Response('',{status:400});
  const m=await req.json(); write({method:m.method,args:m.payload.args}); const a=m.payload.args; let value;
  try {
   if(m.method==='session/create') {
    const id=a.request.sessionId||'session-'+(++next); let s=sessions.get(id);
    if(!s) { s={id,cwd:a.request.cwd,events:[],turn:0,running:false}; sessions.set(id,s); event(s,'session/header',{id}); }
    value={sessionId:id};
   } else if(m.method==='session/list') value={items:[...sessions.values()].map(s=>({sessionId:s.id,cwd:s.cwd,running:s.running,updatedAt:1,projections:projections(s)}))};
   else if(m.method==='session/modelCatalog') value={default:{provider:'configured-provider',model:'configured-model'},groups:[{id:'configured-provider',name:'Configured provider',models:[{id:'configured-model',name:'Configured model'}]}]};
   else if(m.method==='session/attachment') value={attachment:{mediaType:'image/png'},data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII='};
   else if(m.method==='session/projections') value=projections(sessions.get(a.request.sessionId));
   else if(m.method==='session/rename') value={title:a.request.title,seq:1};
   else if(m.method==='session/selectModel') value={selected:{provider:a.request.provider,model:a.request.model,reasoningEffort:a.request.reasoningEffort}};
   else if(m.method==='commands/list') value=[{name:'compact',description:'Condense natively',definitionId:'@deepseek-ai/dsh-command-compact'},{name:'plan',description:'Native plan',input:{hint:'[off|message]'}},{name:'native_custom',description:'A composed plugin command',input:{hint:'<text>'}},{name:'export',description:'Native browser ZIP',definitionId:'@deepseek-ai/dsh-session-log-export'}];
   else if(m.method==='commands/execute') {
    if(a.submittedAttachments===undefined||!a.agentId||!a.line) throw new Error('wrong command signature');
    if(a.line==='/compact') value=await new Promise(resolve=>ask(sessions.get(a.agentId),'approval/request',resolve));
    else {if(a.line.includes('delayed-'))await new Promise(resolve=>setTimeout(resolve,150)); if(a.line.includes('delayed-error'))throw new Error('old command failure'); value={commandId:'command-1',result:{kind:'success',text:'Executed '+a.line}};}
   } else if(m.method==='session/prompt') {
    const s=sessions.get(a.request.sessionId); const text=a.request.content[0].text; value={accepted:true};
    setTimeout(()=>{
     s.running=true;s.turn++;event(s,'turn/start',{turn:s.turn});
     if(text==='approval'||text==='approval-reconnect') { event(s,'tool/call',{turn:s.turn,callId:'tool-1',name:'bash',arguments:'{}'});ask(s,'approval/request'); if(text==='approval-reconnect')setTimeout(()=>{for(const ws of clients)ws.close();},80); }
     else if(text==='questions') ask(s,'user-questions/request');
     else if(text==='timed-question') { const id=ask(s,'user-questions/request');setTimeout(()=>{pending.delete(id);s.continued=true;global({type:'cancel',eventId:id});event(s,'tool/result',{turn:s.turn,message:{toolCallId:'timed-call',content:[{type:'text',text:'pending'}]}});answer(s,'Independent work done');},40); }
     else if(text==='failed') done(s,'error');
     else if(text==='image'){event(s,'assistant/message',{turn:s.turn,message:{id:'image-result',content:[{type:'image',attachment:{attachmentId:'fixture-image'}}]}});done(s);}
     else if(['stream-error','stream-end','gap'].includes(text)){
      for(const ws of clients)for(const [streamId,stream] of ws.data.streams)if(stream.endpoint==='session/follow'&&stream.id===s.id)ws.send(JSON.stringify(text==='gap'?{type:'item',streamId,value:{type:'event',event:{seq:s.events.length+2,type:'fixture/gap',data:{}}}}:text==='stream-end'?{type:'end',streamId}:{type:'error',streamId,error:{code:'fixture',message:'stream failure',details:{}}}));
     }
     else if(text==='slow') {}
     else if(text==='reconnect') {
      event(s,'assistant/message',{turn:s.turn,message:{id:'before',content:[{type:'text',text:'Before reconnect'}]}});
      for(const ws of clients) ws.close();
      setTimeout(()=>{ for(let i=0;i<75;i++) event(s,'fixture/ignored',{index:i}); answer(s,'After reconnect'); },30);
     } else {event(s,'tool/call',{turn:s.turn,callId:'tool-1',name:'bash',arguments:'{}'});event(s,'tool/result',{turn:s.turn,message:{toolCallId:'tool-1',content:[{type:'text',text:'Tool done'}]}});answer(s);}
    },5);
   } else if(m.method==='session/cancel') { const s=sessions.get(a.request.sessionId); for(const [id,p] of pending) if(p.session===s){pending.delete(id);global({type:'cancel',eventId:id});p.commandResolve?.({commandId:'c',result:{kind:'error',text:'Cancelled'}});} if(s.running)done(s,'aborted');value={accepted:true}; }
   else if(m.method==='$events/result') {
    const p=pending.get(a.eventId); if(!p)throw new Error('expired interaction'); pending.delete(a.eventId);
    if(p.commandResolve)p.commandResolve({commandId:'command-compact',result:{kind:'success',text:'Compacted natively'}});
    else if(a.outcome.kind==='result')answer(p.session,'Answer after decision');else done(p.session,'error');
    value=true;
   } else if(m.method==='userQuestions/answer') {const s=sessions.get(a.agentId);value=s.continued===true&&a.callId==='timed-call';s.continued=false;}
   else if(m.method==='session/page') {
    const s=sessions.get(a.request.address.sessionId);
    value={records:s.events.filter(e=>e.seq<a.request.beforeSeq&&e.seq<=a.request.throughSeq).map(event=>({type:'event',event})),hasMore:false};
   } else throw new Error('unsupported '+m.method);
   return Response.json({type:'server-response',rpcId:m.rpcId,result:{ok:true,value}});
  }catch(e){return Response.json({type:'server-response',rpcId:m.rpcId,result:{ok:false,error:{message:e.message,code:'fixture',details:{}}}});}
 },
 websocket:{
  open(ws){clients.add(ws);}, close(ws){clients.delete(ws);},
  message(ws,raw){const m=JSON.parse(String(raw)); if(m.type==='cancel'){ws.data.streams.delete(m.streamId);return;}if(m.type!=='open')return;
   const id=m.payload.args.request?.address?.sessionId; ws.data.streams.set(m.streamId,{endpoint:m.endpoint,id});
   if(m.endpoint==='$events'){ws.send(JSON.stringify({type:'item',streamId:m.streamId,value:{type:'ready',clientId:ws.data.client,host:{home:'/fixture'}}}));for(const [eventId,p] of pending)ws.send(JSON.stringify({type:'item',streamId:m.streamId,value:{type:'waterfall',event:p.kind,eventId,agentId:p.session.id,request:p.request}}));}
   else if(m.endpoint==='session/follow'){const s=sessions.get(id); ws.send(JSON.stringify({type:'item',streamId:m.streamId,value:{type:'snapshot',header:{id},cursor:s.events.length-1,records:s.events.slice(-64).map(event=>({type:'event',event})),hasMore:s.events.length>64,projections:projections(s)}}));}
  }
 }
});
write({launch:process.argv.slice(2)});
console.log('dsh web: '+server.url.origin+'/?token='+token);
process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup(extra: Record<string, string> = {}, blockedDelivery: boolean | "reject" | "throw" = false) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-relay-test-"));
  const bin = join(dir, process.platform === "win32" ? "dsh-fake" : "dsh-fake.js");
  const log = join(dir, "wire.log");
  writeNodeCommand(bin, `#!${process.execPath}\n${fixture}`);
  const events: AgentOutputEvent[] = []; const exits: AgentExitEvent[] = [];
  const driver = new DshDriver({ dshBin: bin, env: { DSH_FAKE_LOG: log, ...extra }, requestTimeoutMs: 1500, startupTimeoutMs: 3000 }, event => { events.push(event); if ((event.type === "approval_request" || event.type === "user_input_request") && blockedDelivery === "throw") throw new Error("delivery failed"); if ((event.type === "approval_request" || event.type === "user_input_request") && blockedDelivery === "reject") return Promise.reject(new Error("delivery failed")); if (blockedDelivery === true) return new Promise<void>(() => undefined); }, event => { exits.push(event); if (blockedDelivery) return new Promise<void>(() => undefined); });
  cleanups.push(async () => { await driver.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const start = (conversationId = "chat-1", threadId?: string) => driver.start({ conversationId, workspaceName: "workspace", workspacePath: dir, ...(threadId ? { threadId } : {}) });
  const messages = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { driver, events, exits, dir, start, messages };
}
async function until(predicate: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("fixture condition timed out"); await Bun.sleep(10); }
}

describe("DeepSeek Harness native Web Remote", () => {
  test("launches loopback with native settings and maps committed tools, messages and completion", async () => {
    const h = setup(); const status = await h.start();
    expect(status.sessionKey).toBe("dsh:chat-1:workspace");
    expect(status.modelProvider).toBe("configured-provider");
    expect(h.messages().find(m => m.launch).launch).toEqual(["--profile", "web", "--no-open", "--host", "127.0.0.1", "--port", "0"]);
    await h.driver.send(status.sessionKey, "hello");
    await until(() => h.events.some(e => e.type === "turn_completed"));
    expect(h.events.filter((e): e is AgentMessageOutputEvent => e.type === "message").map(e => e.chunk)).toEqual(["Native answer"]);
    expect(h.events.some(e => e.type === "activity" && e.activity.kind === "item" && e.activity.status === "completed")).toBe(true);
    expect(h.driver.getStatus(status.sessionKey)?.activeTurnId).toBeUndefined();
    expect(h.messages().find(m => m.method === "session/prompt").args.request.content).toEqual([{ type: "text", text: "hello" }]);
  });
  test("discovers per-session plugin commands and executes exact native text without prompt fallback", async () => {
    const h=setup(); const status=await h.start();
    const catalog=await h.driver.listNativeCommands(status.sessionKey);
    expect(catalog.find(c=>c.command==="/native_custom")?.availability).toBe("supported");
    expect(catalog.find(c=>c.command==="/export")?.availability).toBe("local-only");
    await h.driver.runNativeCommand(status.sessionKey,"/native_custom  exact input");
    await until(()=>h.events.some(e=>e.type==="message"&&e.chunk.includes("Executed")));
    expect(h.messages().find(m=>m.method==="commands/execute").args).toEqual({agentId:status.threadId,line:"/native_custom  exact input",submittedAttachments:[]});
    await expect(h.driver.runNativeCommand(status.sessionKey,"/unknown")).rejects.toThrow("not registered");
    await expect(h.driver.runNativeCommand(status.sessionKey,"/model")).rejects.toThrow("browser picker");
    await expect(h.driver.runNativeCommand(status.sessionKey,"/export")).rejects.toThrow("download");
    await expect(h.driver.send(status.sessionKey,"/unknown")).rejects.toThrow("native-command");
    expect(h.messages().some(m=>m.method==="session/prompt")).toBe(false);
  });
  test("validates native one-shot permission, request ownership and duplicate responses", async () => {
    const h=setup(); const s=await h.start(); const other=await h.start("chat-2");
    await h.driver.send(s.sessionKey,"approval");
    await until(()=>h.events.some(e=>e.type==="approval_request"));
    const request=h.events.find(e=>e.type==="approval_request") as AgentApprovalRequestEvent;
    expect(request.approvalKind).toBe("native_tool");
    await expect(h.driver.respond(other.sessionKey,request.requestId,{action:"once"})).rejects.toThrow("another session");
    await expect(h.driver.respond(s.sessionKey,request.requestId,{action:"session"})).rejects.toThrow("one-shot");
    await h.driver.respond(s.sessionKey,request.requestId,{action:"once"});
    await until(()=>h.events.some(e=>e.type==="turn_completed"));
    expect(h.messages().find(m=>m.method==="$events/result").args.outcome).toEqual({kind:"result",value:"allowed-once"});
    await expect(h.driver.respond(s.sessionKey,request.requestId,{action:"once"})).rejects.toThrow("expired");
  });
  test("keeps native commands responsive while they await approval", async () => {
    const h=setup(); const s=await h.start();
    expect((await h.driver.runNativeCommand(s.sessionKey,"/compact")).message).toContain("Submitted");
    await until(()=>h.events.some(e=>e.type==="approval_request"));
    const request=h.events.find(e=>e.type==="approval_request") as AgentApprovalRequestEvent;
    await h.driver.respond(s.sessionKey,request.requestId,{action:"once"});
    await until(()=>h.events.some(e=>e.type==="message"&&e.chunk==="Compacted natively"));
  });
  test("blocks competing work during native commands and aborts their native request lifetime", async () => {
    const h=setup(); const s=await h.start();
    await h.driver.runNativeCommand(s.sessionKey,"/compact");
    await expect(h.driver.send(s.sessionKey,"do not queue me")).rejects.toThrow("native DSH command is still running");
    await expect(h.driver.runNativeCommand(s.sessionKey,"/plan")).rejects.toThrow("native DSH command is still running");
    await until(()=>h.events.some(e=>e.type==="approval_request"));
    expect((await h.driver.interrupt(s.sessionKey)).interrupted).toBe(true);
    await until(()=>h.events.some(e=>e.type==="activity"&&e.activity.kind==="notice"&&e.activity.title.includes("interrupted")));
    await until(()=>h.driver.getStatus(s.sessionKey)?.waitingForApproval===false);
    await h.driver.send(s.sessionKey,"after cancellation");
  });
  test("never waits on queued Relay output delivery while handling native interaction", async () => {
    const h=setup({},true); const s=await h.start(); await h.driver.send(s.sessionKey,"approval");
    await until(()=>h.events.some(e=>e.type==="approval_request"));
    const request=h.events.find(e=>e.type==="approval_request") as AgentApprovalRequestEvent;
    await h.driver.respond(s.sessionKey,request.requestId,{action:"decline"});
    await until(()=>h.events.some(e=>e.type==="turn_completed"));
    expect(h.messages().find(m=>m.method==="$events/result").args.outcome.value).toBe("rejected");
  });
  test.each(["throw", "reject"] as const)("fails closed when native approval delivery %s fails", async mode => {
    const h=setup({},mode); const s=await h.start(); await h.driver.send(s.sessionKey,"approval");
    await until(()=>h.events.some(e=>e.type==="turn_completed"));
    expect(h.messages().find(m=>m.method==="$events/result").args.outcome).toEqual({kind:"result",value:"unavailable"});
    expect(h.driver.getStatus(s.sessionKey)?.waitingForApproval).toBe(false);
  });
  test.each(["throw", "reject"] as const)("settles native question when delivery %s fails", async mode => {
    const h=setup({},mode); const s=await h.start(); await h.driver.send(s.sessionKey,"questions");
    await until(()=>h.events.some(e=>e.type==="turn_completed"));
    expect(h.messages().find(m=>m.method==="$events/result").args.outcome.kind).toBe("rejected");
    expect(h.driver.getStatus(s.sessionKey)?.waitingForUserInput).toBe(false);
  });
  test("fences stale approval callbacks across native connection generations", async () => {
    const h=setup(); const s=await h.start(); await h.driver.send(s.sessionKey,"approval-reconnect");
    await until(()=>h.events.filter(e=>e.type==="approval_request").length===2);
    const requests=h.events.filter((e):e is AgentApprovalRequestEvent=>e.type==="approval_request");
    expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
    await expect(h.driver.respond(s.sessionKey,requests[0]!.requestId,{action:"once"})).rejects.toThrow("expired");
    await h.driver.respond(s.sessionKey,requests[1]!.requestId,{action:"once"});
    await until(()=>h.events.some(e=>e.type==="turn_completed"));
  });
  test("preserves native multi-select questions and maps selected labels and custom answers", async () => {
    const h=setup(); const s=await h.start(); await h.driver.send(s.sessionKey,"questions");
    await until(()=>h.events.some(e=>e.type==="user_input_request"));
    const request=h.events.find(e=>e.type==="user_input_request") as AgentUserInputRequestEvent;
    expect(request.questions[0]?.multiSelect).toBe(true);
    expect(request.questions[0]?.question).toContain("Native detail");
    await h.driver.respond(s.sessionKey,request.requestId,{answers:{choice:{answers:["One","custom text"]}}});
    expect(h.messages().find(m=>m.method==="$events/result").args.outcome.value).toEqual({answers:[{id:"choice",selected:["One"],custom:"custom text"}]});
  });
  test("keeps timed native questions answerable through their continued-question API", async () => {
    const h=setup(); const s=await h.start(); await h.driver.send(s.sessionKey,"timed-question");
    await until(()=>h.events.some(e=>e.type==="user_input_request"&&e.isBlocking===false));
    const request=h.events.find(e=>e.type==="user_input_request"&&e.isBlocking===false) as AgentUserInputRequestEvent;
    expect(h.driver.getStatus(s.sessionKey)?.waitingForUserInput).toBe(false);
    await h.driver.respond(s.sessionKey,request.requestId,{answers:{late:{answers:["Yes"]}}});
    expect(h.messages().find(m=>m.method==='userQuestions/answer').args).toEqual({agentId:s.threadId,callId:'timed-call',answer:{answers:[{id:'late',selected:['Yes']}]}});
  });
  test("cancels with native endpoint and rejects callbacks withdrawn by native cancellation", async () => {
    const h=setup(); const s=await h.start(); await h.driver.send(s.sessionKey,"approval");
    await until(()=>h.events.some(e=>e.type==="approval_request"));
    const request=h.events.find(e=>e.type==="approval_request") as AgentApprovalRequestEvent;
    expect((await h.driver.interrupt(s.sessionKey)).interrupted).toBe(true);
    await until(()=>h.events.some(e=>e.type==="turn_completed"&&e.status==="interrupted"));
    await expect(h.driver.respond(s.sessionKey,request.requestId,{action:"once"})).rejects.toThrow("expired");
  });
  test("reconnects and repairs missing durable events without replaying visible output", async () => {
    const h=setup(); const s=await h.start(); await h.driver.send(s.sessionKey,"reconnect");
    await until(()=>h.events.some(e=>e.type==="turn_completed"));
    expect(h.events.filter((e): e is AgentMessageOutputEvent=>e.type==="message").map(e=>e.chunk)).toEqual(["Before reconnect","After reconnect"]);
    expect(h.messages().some(m=>m.method==="session/page")).toBe(true);
    await h.driver.send(s.sessionKey,"hello");
  });
  test("lists and resumes native sessions without inventing transcript replay", async () => {
    const h=setup(); const first=await h.start(); const keeper=await h.start("chat-keeper");
    await expect(h.start("another",first.threadId)).rejects.toThrow("another Relay session");
    await h.driver.stop(first.sessionKey);
    const listed=await h.driver.listThreads({workspacePath:h.dir}); expect(listed.some(t=>t.id===first.threadId)).toBe(true);
    const resumed=await h.start("chat-1",first.threadId); expect(resumed.threadId).toBe(first.threadId);
    expect(h.driver.getStatus(keeper.sessionKey)?.running).toBe(true);
    expect((await h.driver.listModels())[0]?.model).toBe("configured-model");
  });
  test("uses live native model catalog for picker mutations", async () => {
    const h=setup(); const s=await h.start();
    await expect(h.driver.setModel(s.sessionKey,'["unknown","model"]')).rejects.toThrow("live catalog");
    await expect(h.driver.setModel(s.sessionKey,'not-json')).rejects.toThrow("Invalid DSH model");
    await h.driver.setModel(s.sessionKey,'["configured-provider","configured-model"]');
    expect(h.messages().find(m=>m.method==="session/selectModel").args.request).toEqual({sessionId:s.threadId,provider:"configured-provider",model:"configured-model"});
  });
  test("intentional stop and restart do not send a stale exit for the replacement session", async () => {
    const h=setup(); const first=await h.start(); await h.driver.stop(first.sessionKey);
    const next=await h.start(); await Bun.sleep(25);
    expect(h.exits).toEqual([]); expect(h.driver.getStatus(next.sessionKey)?.running).toBe(true);
  });
  test("reserves native thread identity across concurrent startups", async () => {
    const h=setup(); await h.start("keeper");
    const results=await Promise.allSettled([h.start("one","persisted-thread"),h.start("two","persisted-thread")]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
    expect(h.messages().filter(m=>m.method==="session/create"&&m.args.request.sessionId==="persisted-thread")).toHaveLength(1);
  });
  test.each(["delayed-success","delayed-error"])("does not deliver %s from an old command into a replacement session", async mode => {
    const h=setup(); const s=await h.start(); await h.start("keeper");
    await h.driver.runNativeCommand(s.sessionKey,"/native_custom "+mode);
    await h.driver.stop(s.sessionKey); await h.start(); const after=h.events.length;
    await Bun.sleep(220);
    expect(h.events.slice(after).some(e=>(e.type==="message"&&e.chunk.includes("delayed-"))||(e.type==="activity"&&e.activity.kind==="notice"&&e.activity.title.includes("native_custom")))).toBe(false);
    expect(h.exits).toHaveLength(0);
  });
  test.each(["stream-error","stream-end","gap"])("terminates a broken authoritative %s instead of staying falsely reconnecting", async fault => {
    const h=setup(); const s=await h.start(); await h.driver.send(s.sessionKey,fault);
    await until(()=>h.exits.length===1);
    expect(h.driver.getStatus(s.sessionKey)).toBeUndefined();
    expect(h.events.some(e=>e.type==="activity"&&e.activity.kind==="notice"&&e.activity.title.includes("restart this session"))).toBe(true);
    const next=await h.start(); expect(next.running).toBe(true);
  });
  test("admits bounded screenshot bytes through the native prompt image schema", async () => {
    const h=setup(); const s=await h.start();
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64');
    const path=join(h.dir,'screen.png'); writeFileSync(path,bytes);
    await h.driver.send(s.sessionKey,'Inspect this screenshot',{attachments:[{type:'localImage',path,caption:'Fixture screenshot'}]});
    const content=h.messages().find(m=>m.method==='session/prompt').args.request.content;
    expect(content).toEqual([{type:'text',text:'Inspect this screenshot'},{type:'text',text:'Fixture screenshot'},{type:'image',mediaType:'image/png',data:bytes.toString('base64'),name:'screen.png'}]);
    await expect(h.driver.send(s.sessionKey,'bad',{attachments:[{type:'image',url:'https://example.invalid/private.png'}]})).rejects.toThrow('not fetched');
    writeFileSync(path,Buffer.alloc(1048577));
    await expect(h.driver.send(s.sessionKey,'large',{images:[{path}]})).rejects.toThrow('size limit');
  });
  test("retrieves native screenshot output through session-authorized attachments", async () => {
    const h=setup(); const s=await h.start(); await h.driver.send(s.sessionKey,'image');
    await until(()=>h.events.some(e=>e.type==='image'));
    expect(h.events.find(e=>e.type==='image')?.mimeType).toBe('image/png');
    expect(h.messages().find(m=>m.method==='session/attachment').args).toEqual({request:{sessionId:s.threadId,attachmentId:'fixture-image'}});
  });
  test("maps native errors and refuses unsupported input without dropping data", async () => {
    const h=setup(); const s=await h.start();
    await expect(h.driver.send(s.sessionKey,"hi",{collaborationMode:"plan",collaborationModeExplicit:true})).rejects.toThrow("native /plan");
    await expect(h.driver.send(s.sessionKey,"hi",{attachments:[{type:"audio",url:"not-read"}]})).rejects.toThrow("unsupported");
    await h.driver.send(s.sessionKey,"failed"); await until(()=>h.events.some(e=>e.type==="turn_completed"));
    expect(h.events.find(e=>e.type==="turn_completed")?.status).toBe("failed");
  });
  test("refuses unverified preview versions and off-host auth redirects without leaking secrets", async () => {
    const old=setup({DSH_FAKE_VERSION:"0.1.7-rc.2"}); await expect(old.start()).rejects.toThrow("verified for 0.2.0-rc.2");
    const bad=setup({DSH_FAKE_REDIRECT:"1"});
    try { await bad.start(); throw new Error("expected rejection"); } catch(error) { expect(String(error)).toContain("browser-session exchange"); expect(String(error)).not.toContain("fixture-launch-secret"); expect(String(error)).not.toContain("example.invalid"); }
  });
});
