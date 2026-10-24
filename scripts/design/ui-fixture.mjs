/** Shared owner IPC fixture; NOT real OAuth, chat or desktop qualification. */
export const fixture = {
  workspace: "/workspace/project",
  connection: "connected",
  headline: "CROT is running",
  cards: [],
  status: [
    { label: "Service", value: "running, pid 4242", marks: [], length: 0 },
    { label: "Account", value: "user_01CANARY", marks: [], length: 0 },
  ],
  presets: [
    { value: "require-approval", label: "Ask for every action", selected: true, available: true },
    { value: "autonomous-browser", label: "Autonomous browser", selected: false, available: true },
    { value: "off", label: "Off (no built-in approvals)", selected: false, available: true },
  ],
  remoteMode: false,
  fullControl: false,
  fullControlNote: "RFC 9207 not advertised",
  remoteNotes: [],
  clients: [],
  pairing: { state: "unpaired", available: true, action: "pair", lines: ["user_01CANARY"] },
  commercial: { state: "current", plan: "free", status: "active", entitled: false, maxDevices: 0, deviceCount: 0 },
  agents: { stdio: 1, httpSessions: 0, remoteClients: 0 },
  browser: { state: "connected", name: "Chromium" },
  modules: [
    { title: "Local service", value: "Online", ready: true },
    { title: "Browser & CDP", value: "Chrome connected", ready: true },
    { title: "L1 sandbox", value: "Setup required", ready: false, repair: true },
    { title: "Cloud tunnel", value: "Local mode", ready: false },
  ],
};
export const shim = `window.fixture=${JSON.stringify(fixture)};window.actions=[];window.crot={product:async(name,input={})=>{window.actions.push([name,input]);const p={id:'fixture-project',name:'project',path:'/workspace/project',favorite:false,tools:[],agents:[],connectors:[]};return {ok:true,...(name==='projects.list'?{projects:[p],active:p.id}:name==='connectors.list'?{connectors:[]}:name==='mcpServers.list'?{servers:[]}:name==='agents.list'?{agents:[],calls:[]}:name==='tasks.list'?{tasks:[]}:name==='monitoring.queryAudit'?{events:[]}:name==='monitoring.metrics'?{tasks:{running:0,total:0},workspace:p.id,connectedServers:0}:{})}},tool:async(name,input)=>{window.actions.push([name,input]);return {content:[{type:"text",text:JSON.stringify(name==="fs_list_directory"?{entries:[{path:"README.md",type:"file"}]}:name==="fs_stat"?{exists:true,type:"directory"}:name==="fs_read_file"?{content:"# Test project"}:name==="browser_tabs_list"?{tabs:[{id:42,title:"Test tab",url:"https://example.test"}]}:{ok:true})}]}},repairL1:async()=>{window.actions.push(["repair-l1"]);return {ok:true,available:false}},onView(fn){window.render=fn},ready(){window.render(window.fixture)},decide:async(...args)=>{window.actions.push(args);return true},action:async(...args)=>{window.actions.push(args);return true}};window.chrome={runtime:{getURL:p=>'/extension/'+p,sendMessage:async(m)=>{window.actions.push(['extension',m.type]);return m.type==='crot.ui.openApp'?{ok:true}:{connection:'disconnected'}}},tabs:{create:async(o)=>{window.actions.push(['tab',o.url]);return o},query:async()=>[{status:'complete',windowId:1,groupId:-1}]},tabGroups:{query:async()=>[]}};`;
