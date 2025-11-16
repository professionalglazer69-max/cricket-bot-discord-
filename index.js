// index.js — Discord cricket bot (Node 18+, discord.js v14/v15)
// Features: setup, modes, filters (category/gender/team), interactive settings panel,
// interactive match picker, throttled live posts, daily summary + tomorrow fixtures,
// manual public scorecard, stop/start, reset filters, role pings, help menu,
// robust batting/bowling parser, improved category heuristics, stable defers, pagination.

import 'dotenv/config';
import fs from 'node:fs';
import {
  Client, GatewayIntentBits, PermissionsBitField,
  REST, Routes,
  SlashCommandBuilder, ChannelType, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';

// ---------- ENV ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CRICKET_API_KEY = process.env.CRICKET_API_KEY;
const POLL_SECONDS = parseInt(process.env.POLL_SECONDS || '600', 10);
const DAILY_SUMMARY_HHMM = process.env.DAILY_SUMMARY_HHMM || '2100';
const DATA_FILE = 'guild_cricket_config.json';

// ---------- CLIENT ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- PERSISTENCE ----------
function loadData() { if (!fs.existsSync(DATA_FILE)) return {}; return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
const data = loadData();
const lastPostedByMatch = {}; // matchId -> epoch

// ---------- HELPERS ----------
const norm = (s)=> (s||'').toString().trim().toLowerCase().replace(/\s+/g,' ');
const todayISO = ()=> new Date().toISOString().slice(0,10);
function dateAddDaysISO(d, days){ const dt=new Date(d); dt.setUTCDate(dt.getUTCDate()+days); return dt.toISOString().slice(0,10); }
const tomorrowISO = ()=> dateAddDaysISO(new Date().toISOString(), 1);

function requireAdmin(interaction) {
  const m = interaction.member?.permissions;
  return m?.has(PermissionsBitField.Flags.ManageGuild) || m?.has(PermissionsBitField.Flags.Administrator);
}
function gid(interaction) { return String(interaction.guildId); }
function ensureGuild(interaction) {
  const g = gid(interaction);
  if (!data[g]) {
    data[g] = {
      channel_id: String(interaction.channelId),
      mode: 'daily',
      filters: ['international', 'domestic'],
      selected_match_ids: [],
      daily_time: DAILY_SUMMARY_HHMM,
      ping_enabled: false,
      role_ids: [],
      team_filters: [],
      gender_filters: ['men','women'],
      is_paused: false
    };
    saveData();
  }
}
function hhmmToNextDate(hhmm) {
  const now = new Date();
  let hh = 21, mm = 0;
  try { hh = parseInt(hhmm.slice(0,2),10); mm = parseInt(hhmm.slice(2),10); } catch {}
  const t = new Date(now); t.setHours(hh,mm,0,0); if (t <= now) t.setDate(t.getDate()+1); return t;
}
function chunkText(text, maxLen=1900){
  const lines = text.split('\n'), chunks=[], curInit='';
  let cur=curInit;
  for(const line of lines){
    if((cur+'\n'+line).length>maxLen){
      if(cur) chunks.push(cur);
      if(line.length>maxLen){ for(let i=0;i<line.length;i+=maxLen) chunks.push(line.slice(i,i+maxLen)); cur=''; }
      else cur=line;
    } else cur = cur? cur+'\n'+line : line;
  }
  if(cur) chunks.push(cur);
  return chunks;
}
function pickString(v,...keys){
  if (typeof v==='string') return v;
  if (v && typeof v==='object'){
    for(const k of ['name','fullName','fullname','shortName','playerName','text','kind','howOut']){
      if (typeof v[k]==='string' && v[k].trim()) return v[k];
    }
  }
  for(const k of keys){
    const x=v?.[k];
    if (typeof x==='string' && x.trim()) return x;
    if (x && typeof x==='object'){ const got=pickString(x); if (got) return got; }
  }
  return '';
}
function pickNum(obj, keys=[], fallback=0){
  for (const k of keys){
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined && obj[k] !== null){
      const n = Number(obj[k]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return fallback;
}

// --- SAFE DEFER / REPLY HELPERS ---
async function safeDefer(interaction, ephemeral = true) {
  try {
    if (interaction.deferred || interaction.replied) return true;
    // v15 prefers flags:64; v14 needs ephemeral:true — try both patterns:
    try { await interaction.deferReply({ flags: (ephemeral ? (1<<6) : undefined) }); }
    catch { await interaction.deferReply({ ephemeral }); }
    return true;
  } catch (e) {
    console.warn('[safeDefer] failed', e?.code || e?.message || e);
    return false;
  }
}
async function safeEdit(interaction, payload, ephemeral = true) {
  try {
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload);
    }
    try { return await interaction.reply({ ...payload, flags: (ephemeral ? (1<<6) : undefined) }); }
    catch { return await interaction.reply({ ...payload, ephemeral }); }
  } catch (e) {
    console.warn('[safeEdit] failed', e?.code || e?.message || e);
  }
}

// ---------- MATCH/EMBED HELPERS ----------
function matchIdOf(m){ return String(m.id ?? m.unique_id ?? m.matchId ?? m.name ?? ''); }
function fmtInnings(scoreObj={}){
  const keys=['inning1','inning2','inning3','inning4']; const parts=[];
  for(const k of keys){
    const inn=scoreObj[k]; if(!inn) continue;
    const name=inn.inning ?? k; const r=inn.r ?? '?'; const w=inn.w ?? '?'; const o=inn.o ?? inn.O ?? '?';
    parts.push(`${name}: ${r}/${w} (${o})`);
  }
  return parts.length? parts.join(' • ') : null;
}
function buildEmbed(match){
  const title=match.name||'Cricket Match';
  const status=match.status||''; const venue=match.venue||''; const series=match.series||'';
  const matchType=(match.matchType||'').toUpperCase(); const score=match.score||{};
  const descParts=[]; const inns=fmtInnings(score); if(inns) descParts.push(inns); if(status) descParts.push(status);
  const em=new EmbedBuilder().setTitle(matchType?`${title}  |  ${matchType}`:title)
    .setDescription(descParts.length?descParts.join('\n'):'Score not available yet.')
    .setColor(0x5865F2).setTimestamp(new Date());
  if(series) em.addFields({name:'Series', value:String(series), inline:true});
  if(venue) em.addFields({name:'Venue', value:String(venue), inline:true});
  const teamInfo=match.teamInfo||[]; if (teamInfo[0]?.img) em.setThumbnail(teamInfo[0].img);
  em.setFooter({ text:'CricketData (near-live)' }); return em;
}

// ---------- SETTINGS PANEL UI ----------
function fmtOnOff(v){ return v ? 'ON ✅' : 'OFF ❌'; }
function fmtList(arr){ return (arr && arr.length)? arr.join(', ') : 'none'; }
function buildSettingsEmbed(cfg) {
  const ch = cfg.channel_id ? `<#${cfg.channel_id}>` : 'not set';
  const roles = (cfg.role_ids||[]).map(r=>`<@&${r}>`).join(', ') || 'none';
  const genders = (cfg.gender_filters||['men','women']).join(', ');
  const cats = (cfg.filters||[]).join(', ') || 'none';
  const teams = fmtList(cfg.team_filters||[]);
  const paused = cfg.is_paused ? 'Disabled ❌' : 'Enabled ✅';

  return new EmbedBuilder()
    .setTitle('🛠️ Cricket Bot — Settings')
    .setColor(0x2f3136)
    .setDescription('Configure this server’s cricket updates using the buttons below.')
    .addFields(
      { name: 'Status', value: `System: **${paused}**\nPings: **${fmtOnOff(cfg.ping_enabled)}**\nMode: **${cfg.mode||'daily'}**`, inline: true },
      { name: 'Message Settings', value: `Channel: ${ch}\nDaily Time: \`${cfg.daily_time}\``, inline: true },
      { name: 'Filters', value: `Categories: \`${cats}\`\nGender: \`${genders}\`\nTeams: \`${teams}\`` },
      { name: 'Allowed Roles', value: roles }
    )
    .setFooter({ text: 'Use /cricket-channel to change the post channel. /cricket-ping-roles to manage roles.' });
}
function buildSettingsButtons(cfg){
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_toggle_system').setStyle(ButtonStyle.Secondary)
      .setLabel(cfg.is_paused ? 'System: Disabled ❌' : 'System: Enabled ✅'),
    new ButtonBuilder().setCustomId('settings_toggle_mode').setStyle(ButtonStyle.Primary)
      .setLabel(cfg.mode === 'custom' ? 'Mode: custom' : 'Mode: daily'),
    new ButtonBuilder().setCustomId('settings_toggle_pings').setStyle(ButtonStyle.Success)
      .setLabel(cfg.ping_enabled ? 'Pings: ON' : 'Pings: OFF'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_set_filters').setStyle(ButtonStyle.Secondary).setLabel('Set Categories'),
    new ButtonBuilder().setCustomId('settings_set_gender').setStyle(ButtonStyle.Secondary).setLabel('Set Gender'),
    new ButtonBuilder().setCustomId('settings_refresh').setStyle(ButtonStyle.Secondary).setLabel('Refresh'),
  );
  return [row1, row2];
}
function buildCategorySelect(current=[]) {
  const opts = [
    { label:'International', value:'international' },
    { label:'First-class',   value:'first-class' },
    { label:'Domestic',      value:'domestic' },
    { label:'Franchise',     value:'franchise' },
  ];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('settings_select_categories')
      .setPlaceholder('Select one or more categories')
      .setMinValues(1)
      .setMaxValues(opts.length)
      .addOptions(opts.map(o => ({ ...o, default: current.includes(o.value) })))
  );
}
function buildGenderSelect(current=['men','women']) {
  const opts = [
    { label:'Men', value:'men' },
    { label:'Women', value:'women' },
  ];
  const defaults = new Set(current);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('settings_select_gender')
      .setPlaceholder('Select gender(s)')
      .setMinValues(1)
      .setMaxValues(2)
      .addOptions(opts.map(o => ({ ...o, default: defaults.has(o.value) })))
  );
}

// ---------- HELP TEXT ----------
function buildHelpChunks(prefix = '/') {
  const lines = [
    '**Cricket Bot — Help**',
    '',
    '__Setup & status__',
    `• **${prefix}cricket-channel** — Set where the bot posts.\n  _Example:_ ${prefix}cricket-channel channel:#scores`,
    `• **${prefix}cricket-setup** — Set channel + mode in one go.\n  _Example:_ ${prefix}cricket-setup mode:custom channel:#scores`,
    `• **${prefix}cricket-status** — Show current settings.`,
    `• **${prefix}stop** / **${prefix}start** — Pause/resume all activity.`,
    `• **${prefix}cricket-reset** — Reset filters (category, gender, teams) to defaults.`,
    '',
    '__Modes__',
    `• **${prefix}cricket-mode** — Switch posting mode (custom/daily).\n  _Example:_ ${prefix}cricket-mode mode:daily`,
    `• **${prefix}cricket-daily-time** — Set daily summary time (HHMM, 24h).\n  _Example:_ ${prefix}cricket-daily-time hhmm:2100`,
    '',
    '__Filters__',
    `• **${prefix}cricket-filters** — Set categories: international, first-class, domestic, franchise`,
    `• **${prefix}cricket-gender** — Men/Women/Both.`,
    `• **${prefix}cricket-teams** — Add/remove/clear team filters.`,
    '',
    '__Tracking (custom mode)__',
    `• **${prefix}cricket-list** — List current matches for your filters (copy an ID).`,
    `• **${prefix}cricket-select** — Add/remove a match ID to track.`,
    `• **${prefix}set-match** — Interactive picker (category/gender/team).`,
    '',
    '__Summaries__',
    `• **${prefix}cricket-summary** — Public full scorecard by match ID.`,
    `• **${prefix}cricket-tomorrow** — Tomorrow’s international fixtures.`,
    '',
    '__Pings__',
    `• **${prefix}cricket-ping-toggle** — Enable/disable role pings.`,
    `• **${prefix}cricket-ping-roles** — Add/remove a role to ping.`,
    `• **${prefix}cricket-ping-test** — Test ping in the post channel.`,
    '',
    `• **${prefix}cricket-settings** — Open a clickable settings panel (admin only).`,
  ];
  return chunkText(lines.join('\n'), 1900);
}

// ---------- API CALLS (with pagination + safety) ----------
async function fetchJSON(url){ const r=await fetch(url,{timeout:25000}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
async function fetchPaginated(baseUrl) {
  let all = [], offset = 0;
  for (;;) {
    const j = await fetchJSON(`${baseUrl}&offset=${offset}`);
    if (j.status !== "success") break;
    all = all.concat(j.data || []);
    const total = j.info?.totalRows || 0;
    if (offset + 25 >= total) break;
    offset += 25;
  }
  return all;
}
async function getCurrentMatches(){ return await fetchPaginated(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICKET_API_KEY}`); }
async function getTodayMatches(){ const all=await fetchPaginated(`https://api.cricapi.com/v1/matches?apikey=${CRICKET_API_KEY}`); const today=todayISO();
  return all.filter(m=>{ try{ return new Date(m.dateTimeGMT).toISOString().slice(0,10)===today; }catch{return false;} }); }
async function getMatchesForISO(iso){ const all=await fetchPaginated(`https://api.cricapi.com/v1/matches?apikey=${CRICKET_API_KEY}`);
  return all.filter(m=>{ try{ return new Date(m.dateTimeGMT).toISOString().slice(0,10)===iso; }catch{return false;} }); }

// ---------- Heuristics (category & gender) ----------
const FRANCHISE_MAP=['indian premier league','ipl','big bash','bbl','pakistan super league','psl','caribbean premier league','cpl','the hundred','bangladesh premier league','bpl','lanka premier league','lpl','sa20','major league cricket','mlc','global t20','gt20','super smash','t10 league','abu dhabi t10'];
const FIRST_CLASS_MAP=['ranji trophy','sheffield shield','county championship','plunket shield','logan cup','quaid-e-azam trophy','four-day','4-day'];
const DOMESTIC_LISTA_T20_MAP=['vijay hazare trophy','syed mushtaq ali','smat','royal london one-day','deodhar trophy','duleep trophy','momentum one day cup','marsh one-day cup','national t20 cup','super50','one-day cup'];
const INDIAN_DOMESTIC_SERIES=['ranji trophy','vijay hazare','syed mushtaq ali','smat','duleep trophy','deodhar trophy','irani cup','elite group','plate'];
const STRONG_INTL = ['t20i','odi','test','icc','world cup','asia cup','champions trophy','tri-series','tour of','international'];
function isIndianDomestic(match){
  const series=norm(match.series||match.name);
  if (INDIAN_DOMESTIC_SERIES.some(k=>series.includes(k))) return true;
  const teamInfo=match.teamInfo||[];
  const names=teamInfo.map(t=>[norm(t.name),norm(t.shortname)]).flat().filter(Boolean).join(' ');
  const states=['mumbai','delhi','karnataka','tamil nadu','bengal','saurashtra','vidarbha','baroda','gujarat','maharashtra','punjab','services','railways','uttarakhand','hyderabad','andhra','kerala','jharkhand','jammu','kashmir','haryana','uttar pradesh','madhya pradesh','assam','goa','tripura','manipur','meghalaya','mizoram','nagaland','sikkim','chhattisgarh','himachal','rajasthan','pondicherry','chandigarh','odisha','orissa'];
  return states.some(s=>names.includes(s));
}
function guessCategory(match){
  const series=norm(match.series||match.name);
  const mtype=norm(match.matchType||'');
  if (isIndianDomestic(match)) {
    if (series.includes('ranji') || series.includes('elite group') || series.includes('plate') || mtype.includes('first class') || mtype.includes('four-day') || mtype.includes('4-day')) return 'first-class';
    return 'domestic';
  }
  if (FRANCHISE_MAP.some(k=>series.includes(k))) return 'franchise';
  if (series.includes('first class') || FIRST_CLASS_MAP.some(k=>series.includes(k)) || mtype.includes('first class') || mtype.includes('four-day') || mtype.includes('4-day')) return 'first-class';
  if (series.includes('list a') || DOMESTIC_LISTA_T20_MAP.some(k=>series.includes(k)) || mtype.includes('list a') || (mtype.includes('t20') && !mtype.includes('t20i'))) return 'domestic';
  if (STRONG_INTL.some(k=>series.includes(k)) || /(t20i|odi|test)/.test(mtype)) return 'international';
  return 'domestic';
}
function guessGender(match){
  const series=norm(match.series||match.name);
  const teamInfo=match.teamInfo||[];
  const teamStr=teamInfo.map(t=>[norm(t.name),norm(t.shortname)]).flat().filter(Boolean).join(' ');
  if (series.includes('women')||series.includes('womens')) return 'women';
  if (teamStr.includes(' women')) return 'women';
  const short=teamInfo.map(t=>norm(t.shortname||'')); if (short.some(sn=>/-w\b| women\b/.test(sn))) return 'women';
  return 'men';
}
const FINISHED_RE = /(stump|stumps|abandon|no result|completed|won by|finished)/i;
function relevantLive(m){
  const status=norm(m.status);
  if (/(live|day|inning|session|break|opt to bat|opt to bowl)/.test(status)) return true;
  const started=String(m.matchStarted??'').toLowerCase()==='true';
  if (started && !FINISHED_RE.test(status)) return true;
  return false;
}
function genderAllowed(match, genders){ const g=guessGender(match); return (genders||['men','women']).includes(g); }
function categoryAllowed(match, allowed){ const cat=guessCategory(match); return (allowed||[]).includes(cat); }
function isTodayOrLive(m){ const dtg=m.dateTimeGMT; try{ if(dtg){ const d=new Date(dtg).toISOString().slice(0,10); if(d===todayISO()) return true; } }catch{} return relevantLive(m); }
function matchTeamNames(match){ const ti=match.teamInfo||[]; return ti.map(t=>[norm(t.name),norm(t.shortname)]).flat().filter(Boolean).join(' '); }
function teamAllowed(match, teamFilters){ if(!teamFilters||teamFilters.length===0) return true; const names=matchTeamNames(match); return teamFilters.some(tok=>names.includes(norm(tok))); }
function mentionText(cfg){ if(!cfg.ping_enabled) return null; const roles=(cfg.role_ids||[]).map(r=>`<@&${r}>`); return roles.length? roles.join(' ') : null; }

// ---------- SCORECARD ----------
function isFinishedOrStumps(m){ return FINISHED_RE.test((m.status||'').toString()); }
async function fetchScorecard(matchId){
  const url = `https://api.cricapi.com/v1/match_scorecard?apikey=${CRICKET_API_KEY}&id=${encodeURIComponent(matchId)}`;
  const j = await fetchJSON(url); return j?.data || {};
}
function getBatterName(row){ return pickString(row.batsman)||pickString(row.player)||pickString(row.name)||pickString(row.striker)||'—'; }
function getBowlerName(row){ return pickString(row.bowler)||pickString(row.player)||pickString(row.name)||'—'; }
function getDismissalText(row){
  const d=row.out ?? row.dismissal ?? row.howOut; const txt=pickString(d); if(txt) return txt;
  const keys=['lbw','bowled','caught','runout','run out']; for(const k of keys) if(String(row[k])==='true') return k; return '';
}
function formatBatting(rows=[]){
  const lines=rows.map(r=>{
    const n=getBatterName(r); const out=getDismissalText(r);
    const R=pickNum(r, ['r','R','runs','Runs'], 0);
    const B=pickNum(r, ['b','B','balls','bf','BF'], 0);
    const F4=pickNum(r, ['4s','Fours','fours','F4'], 0);
    const S6=pickNum(r, ['6s','Sixes','sixes','S6'], 0);
    const SR = r.sr ?? r.SR ?? r.strikeRate ?? r.StrikeRate ?? '';
    return `${n}${out?` — ${out}`:''}\n ${R} (${B})  4s:${F4}  6s:${S6}  SR:${SR}`;
  });
  return chunkText(lines.join('\n'), 900);
}
function formatBowling(rows=[]){
  const lines=rows.map(r=>{
    const n=getBowlerName(r);
    const O = pickNum(r, ['o','O','overs','Ov','OV'], 0);
    const M = pickNum(r, ['m','M','maidens','Mdns','Md'], 0);
    const R = pickNum(r, ['r','R','runs','Runs'], 0);
    const W = pickNum(r, ['w','W','wkts','Wkts','wickets','Wickets'], 0);
    const E = r.eco ?? r.ECO ?? r.econ ?? r.Econ ?? r.economy ?? r.Economy ?? '';
    const WD = pickNum(r, ['wd','WD','wides','Wides'], null);
    const NB = pickNum(r, ['nb','NB','noballs','NoBalls'], null);
    const Dots = pickNum(r, ['0s','dots','Dots'], null);
    let extra = [];
    if (WD !== null) extra.push(`Wd:${WD}`);
    if (NB !== null) extra.push(`Nb:${NB}`);
    if (Dots !== null) extra.push(`0s:${Dots}`);
    const extraStr = extra.length ? `  ${extra.join('  ')}` : '';
    return `${n}\n ${O} overs  M:${M}  R:${R}  W:${W}  Econ:${E}${extraStr}`;
  });
  return chunkText(lines.join('\n'), 900);
}
function scorecardEmbedsFrom(scoreData={}){
  const embeds=[]; const title=scoreData?.info?.name || scoreData?.info?.matchType || 'Match Summary';
  const series=scoreData?.info?.series || ''; const venue=scoreData?.info?.venue || ''; const status=scoreData?.info?.status || '';
  const top=new EmbedBuilder().setTitle(`${title} — Summary`).setDescription(status||'Summary').setColor(0x43B581).setTimestamp(new Date());
  if(series) top.addFields({name:'Series',value:series,inline:true}); if(venue) top.addFields({name:'Venue',value:venue,inline:true}); embeds.push(top);
  const sc=scoreData?.scorecard || scoreData?.score || [];
  for(const inn of sc){
    const head=inn?.inning || inn?.name || 'Innings'; const em=new EmbedBuilder().setTitle(head).setColor(0x7289DA);
    const bat=inn?.batting || inn?.batsmen || inn?.bat || []; const batChunks=formatBatting(bat);
    if(batChunks.length){ em.addFields({name:'Batting', value:batChunks[0]}); for(let i=1;i<batChunks.length;i++) em.addFields({name:'Batting (cont.)', value:batChunks[i]}); }
    const bowl=inn?.bowling || inn?.bowlers || inn?.bowl || []; const bowlChunks=formatBowling(bowl);
    if(bowlChunks.length){ em.addFields({name:'Bowling', value:bowlChunks[0]}); for(let i=1;i<bowlChunks.length;i++) em.addFields({name:'Bowling (cont.)', value:bowlChunks[i]}); }
    embeds.push(em);
  }
  return embeds.slice(0,10);
}

// ---------- SAFE WRAPPERS ----------
async function getCurrentMatchesSafe(){ try{return await getCurrentMatches();}catch{return[];} }
async function getTodayMatchesSafe(){ try{return await getTodayMatches();}catch{return[];} }
async function getMatchesForISOSafe(iso){ try{return await getMatchesForISO(iso);}catch{return[];} }

// ---------- TOMORROW ----------
function formatTomorrowList(matches, genders, teams){
  const filtered=matches.filter(m=>guessCategory(m)==='international').filter(m=>genderAllowed(m,genders)).filter(m=>teamAllowed(m,teams));
  if(filtered.length===0) return ['No international matches scheduled for tomorrow with your filters.'];
  const lines=filtered.map(m=>{
    const nm=m.name||'Match'; const series=m.series||''; const dt=m.dateTimeGMT? new Date(m.dateTimeGMT).toUTCString() : 'Time TBA'; const gen=guessGender(m);
    return `• ${nm} • ${series} • ${gen} • ${dt}`;
  });
  return chunkText(['**Tomorrow — International fixtures:**', ...lines].join('\n'), 1900);
}
async function sendTomorrowsInternationals(channel, cfg){
  const iso=tomorrowISO(); const matches=await getMatchesForISOSafe(iso);
  const chunks=formatTomorrowList(matches, cfg.gender_filters||['men','women'], cfg.team_filters||[]);
  for(const c of chunks){ await channel.send({content:c}); }
}

// ---------- SCHEDULER ----------
const IDLE_BACKOFF_SECONDS = 1800;
async function tick(){
  const now=Date.now()/1000;
  for(const [gId,cfg] of Object.entries(data)){
    try{
      if(cfg.is_paused) continue;
      const channelId=cfg.channel_id; if(!channelId) continue;
      const channel=await client.channels.fetch(channelId).catch(()=>null); if(!channel) continue;

      const mode=cfg.mode||'daily';
      const filters=cfg.filters||['international','first-class','domestic','franchise'];
      const sel=new Set(cfg.selected_match_ids||[]);
      const dailyHHMM=cfg.daily_time||DAILY_SUMMARY_HHMM;
      const pingStr=mentionText(cfg);
      const allowedMentions= pingStr? {parse:[], roles:cfg.role_ids||[]} : {parse:[]};
      const teams=cfg.team_filters||[];
      const genders=cfg.gender_filters||['men','women'];

      if(mode==='custom' && sel.size>0){
        const key=`next_due_${gId}`; const nextDue=cfg[key]||0;
        if(now>=nextDue){
          const matches=await getCurrentMatchesSafe();
          let anyLive=false;
          for(const m of matches){
            const mid=matchIdOf(m);
            if(sel.has(mid) && categoryAllowed(m,filters) && genderAllowed(m,genders) && teamAllowed(m,teams)){
              if(FINISHED_RE.test(String(m.status||''))){
                try{ const sc=await fetchScorecard(mid); const embeds=scorecardEmbedsFrom(sc); if(embeds.length) await channel.send({content:'🧾 Final scorecard:', embeds}); }catch{}
                sel.delete(mid); data[gId].selected_match_ids=[...sel]; saveData();
                await channel.send({content:`🛑 Stopped tracking \`${mid}\` — match ended / Stumps.`});
                continue;
              }
              if(relevantLive(m)){
                anyLive=true;
                const last=lastPostedByMatch[mid]||0;
                if(now-last>=POLL_SECONDS-5){
                  await channel.send({ content: pingStr || undefined, embeds:[buildEmbed(m)], allowedMentions });
                  lastPostedByMatch[mid]=now;
                }
              }
            }
          }
          cfg[key]=now+(anyLive? POLL_SECONDS : IDLE_BACKOFF_SECONDS); saveData();
        }
      }

      if(mode==='custom' && sel.size===0){
        const nrKey=`fallback_summary_${gId}`; let nextRun=cfg[nrKey];
        if(!nextRun){ cfg[nrKey]=Math.floor(hhmmToNextDate(dailyHHMM).getTime()/1000); saveData(); }
        else if(now>=nextRun){
          const current=await getCurrentMatchesSafe(); const todays=await getTodayMatchesSafe();
          const byId={}; for(const m of [...todays,...current]) byId[matchIdOf(m)]=m;
          const matches=Object.values(byId).filter(m=>{ const cat=guessCategory(m); const ok=(cat==='international')||(cat==='domestic'&&isIndianDomestic(m))||(cat==='first-class'&&isIndianDomestic(m)); return ok && isTodayOrLive(m) && genderAllowed(m,genders) && teamAllowed(m,teams); });
          if(matches.length===0) await channel.send('📋 No international or Indian domestic matches to summarize today.');
          else { for(let i=0;i<matches.length;i+=8){ const slice=matches.slice(i,i+8); await channel.send({ content:(i===0? pingStr:undefined), embeds:slice.map(buildEmbed), allowedMentions }); } }
          await sendTomorrowsInternationals(channel, cfg);
          cfg[nrKey]=Math.floor((new Date(nextRun*1000)).getTime()/1000)+86400; saveData();
        }
      }

      if(mode==='daily'){
        const nrKey=`next_summary_${gId}`; let nextRun=cfg[nrKey];
        if(!nextRun){ cfg[nrKey]=Math.floor(hhmmToNextDate(dailyHHMM).getTime()/1000); saveData(); }
        else if(now>=nextRun){
          const current=await getCurrentMatchesSafe(); const todays=await getTodayMatchesSafe();
          const byId={}; for(const m of [...todays,...current]) byId[matchIdOf(m)]=m;
          const matches=Object.values(byId).filter(m=> categoryAllowed(m,filters) && isTodayOrLive(m) && genderAllowed(m,genders) && teamAllowed(m,teams) );
          if(matches.length===0) await channel.send('📋 No matches to summarize today for the chosen filters/teams.');
          else { for(let i=0;i<matches.length;i+=8){ const slice=matches.slice(i,i+8); await channel.send({ content:(i===0? pingStr:undefined), embeds:slice.map(buildEmbed), allowedMentions }); } }
          await sendTomorrowsInternationals(channel, cfg);
          cfg[nrKey]=Math.floor((new Date(nextRun*1000)).getTime()/1000)+86400; saveData();
        }
      }
    } catch(e){ console.log('[tick error]', e); }
  }
}

// ---------- COMMANDS ----------
const choicesMode=[{name:'custom (track selected)', value:'custom'},{name:'daily (one summary per day)', value:'daily'}];
const choicesAction=[{name:'add', value:'add'},{name:'remove', value:'remove'}];
const choicesTeamAction=[{name:'add', value:'add'},{name:'remove', value:'remove'},{name:'clear', value:'clear'}];
const choicesCategory=[{name:'International', value:'international'},{name:'Domestic', value:'domestic'}];
const choicesGender=[{name:'Men only', value:'men'},{name:'Women only', value:'women'},{name:'Both', value:'both'}];

const commands = [
  new SlashCommandBuilder().setName('cricket-channel').setDescription('(Admin) Set the posting channel')
    .addChannelOption(o=>o.setName('channel').setDescription('Select a text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('cricket-filters').setDescription('(Admin) Set categories (comma separated)')
    .addStringOption(o=>o.setName('categories').setDescription('international, first-class, domestic, franchise').setRequired(true)),
  new SlashCommandBuilder().setName('cricket-teams').setDescription('(Admin) Add/remove/clear team filters')
    .addStringOption(o=>o.setName('action').setDescription('add/remove/clear').setRequired(true).addChoices(...choicesTeamAction))
    .addStringOption(o=>o.setName('team').setDescription('Team text (ignored for clear)').setRequired(false)),
  new SlashCommandBuilder().setName('cricket-gender').setDescription('(Admin) Filter by Men/Women/Both')
    .addStringOption(o=>o.setName('value').setDescription('men / women / both').setRequired(true).addChoices(...choicesGender)),
  new SlashCommandBuilder().setName('cricket-mode').setDescription('(Admin) Switch between custom/daily')
    .addStringOption(o=>o.setName('mode').setDescription('custom or daily').setRequired(true).addChoices(...choicesMode)),
  new SlashCommandBuilder().setName('cricket-daily-time').setDescription('(Admin) Set daily summary time (HHMM)')
    .addStringOption(o=>o.setName('hhmm').setDescription('e.g., 0930 or 2100').setRequired(true)),
  new SlashCommandBuilder().setName('cricket-status').setDescription('Show current bot settings'),
  new SlashCommandBuilder().setName('cricket-ping-toggle').setDescription('(Admin) Enable/disable role pings')
    .addBooleanOption(o=>o.setName('enabled').setDescription('true/false').setRequired(true)),
  new SlashCommandBuilder().setName('cricket-ping-roles').setDescription('(Admin) Add/remove a role to ping')
    .addStringOption(o=>o.setName('action').setDescription('add/remove').setRequired(true).addChoices(...choicesAction))
    .addRoleOption(o=>o.setName('role').setDescription('Role to ping').setRequired(true)),
  new SlashCommandBuilder().setName('cricket-ping-test').setDescription('(Admin) Send a test ping'),
  new SlashCommandBuilder().setName('cricket-list').setDescription('List current matches (respects filters/teams/gender)'),
  new SlashCommandBuilder().setName('cricket-select').setDescription('(Admin) Add/remove a match ID for custom tracking')
    .addStringOption(o=>o.setName('action').setDescription('add/remove').setRequired(true).addChoices(...choicesAction))
    .addStringOption(o=>o.setName('match_id').setDescription('Paste match ID from /cricket-list').setRequired(true)),
  new SlashCommandBuilder().setName('cricket-setup').setDescription('(Admin) Set channel and mode')
    .addStringOption(o=>o.setName('mode').setDescription('custom/daily').setRequired(true).addChoices(...choicesMode))
    .addChannelOption(o=>o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('set-match').setDescription('(Admin) Pick a match to track interactively.')
    .addStringOption(o=>o.setName('category').setDescription('International or Domestic').setRequired(true).addChoices(...choicesCategory))
    .addStringOption(o=>o.setName('gender').setDescription('men / women / both').addChoices(...choicesGender))
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to post into (optional)').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName('team').setDescription('Optional: narrow by team (e.g., India, Karnataka)')),
  new SlashCommandBuilder().setName('cricket-summary').setDescription('Get full scorecard for a match (finished/stumps/live)')
    .addStringOption(o=>o.setName('match_id').setDescription('Match ID (from /cricket-list or /set-match)').setRequired(true)),
  new SlashCommandBuilder().setName('cricket-tomorrow').setDescription('Show tomorrow’s international fixtures (respects gender/team filters)'),
  new SlashCommandBuilder().setName('stop').setDescription('(Admin) Pause all bot activity for this server'),
  new SlashCommandBuilder().setName('start').setDescription('(Admin) Resume bot activity for this server'),
  new SlashCommandBuilder().setName('cricket-reset').setDescription('(Admin) Reset category, gender, and team filters to defaults'),
  new SlashCommandBuilder().setName('cricket-help').setDescription('Show all commands, what they do, and examples'),
  new SlashCommandBuilder().setName('cricket-settings').setDescription('(Admin) Open interactive settings panel'),
].map(c=>c.toJSON());

// ---------- REGISTER ----------
async function onBoot() {
  console.log(`Logged in as ${client.user.tag}`);
  const rest=new REST({version:'10'}).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands }).catch(console.error);
  setInterval(tick, 60*1000);
}
client.once('ready', onBoot);
client.once('clientReady', onBoot);

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async (interaction)=>{
  try{
    // Buttons / select menus first (settings panel)
    if (interaction.isButton()) {
      const id = interaction.customId;
      const g = interaction.guildId; if (!g) return;
      ensureGuild(interaction); const cfg = data[g];
      if (!requireAdmin(interaction)) return interaction.reply({ content:'You need **Manage Server** permission to change settings.', ephemeral:true }).catch(()=>{});
      if (id === 'settings_toggle_system') { cfg.is_paused=!cfg.is_paused; saveData(); return interaction.update({ embeds:[buildSettingsEmbed(cfg)], components:buildSettingsButtons(cfg) }).catch(()=>{}); }
      if (id === 'settings_toggle_mode') { cfg.mode=(cfg.mode==='custom')?'daily':'custom'; saveData(); return interaction.update({ embeds:[buildSettingsEmbed(cfg)], components:buildSettingsButtons(cfg) }).catch(()=>{}); }
      if (id === 'settings_toggle_pings') { cfg.ping_enabled=!cfg.ping_enabled; saveData(); return interaction.update({ embeds:[buildSettingsEmbed(cfg)], components:buildSettingsButtons(cfg) }).catch(()=>{}); }
      if (id === 'settings_set_filters') { const row = buildCategorySelect(cfg.filters || ['international','domestic']); return interaction.reply({ content:'Select categories (1–4):', components:[row], ephemeral:true }).catch(()=>{}); }
      if (id === 'settings_set_gender') { const row = buildGenderSelect(cfg.gender_filters || ['men','women']); return interaction.reply({ content:'Select gender(s):', components:[row], ephemeral:true }).catch(()=>{}); }
      if (id === 'settings_refresh') { return interaction.update({ embeds:[buildSettingsEmbed(cfg)], components:buildSettingsButtons(cfg) }).catch(()=>{}); }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const g = interaction.guildId; if (!g) return;
      ensureGuild(interaction); const cfg = data[g];
      if (!requireAdmin(interaction)) return interaction.reply({ content:'You need **Manage Server** permission to change settings.', ephemeral:true }).catch(()=>{});
      if (id === 'settings_select_categories') { cfg.filters = interaction.values; saveData(); return interaction.update({ content: `✅ Categories set to: \`${cfg.filters.join(', ')}\``, components: [] }).catch(()=>{}); }
      if (id === 'settings_select_gender') { cfg.gender_filters = interaction.values; saveData(); return interaction.update({ content: `✅ Gender filter set to: \`${cfg.gender_filters.join(', ')}\``, components: [] }).catch(()=>{}); }
      return;
    }

    if(!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;

    if (name.startsWith('cricket') || name === 'set-match' || name === 'stop' || name === 'start') ensureGuild(interaction);
    const g = gid(interaction); const cfg = data[g];

    const adminOnly = new Set([
      'cricket-channel','cricket-filters','cricket-gender','cricket-teams','cricket-mode','cricket-daily-time',
      'cricket-ping-toggle','cricket-ping-roles','cricket-ping-test','cricket-select','cricket-setup','set-match',
      'stop','start','cricket-reset','cricket-settings'
    ]);
    if (adminOnly.has(name) && !requireAdmin(interaction)) {
      return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true }).catch(()=>{});
    }

    // Defer heavy commands
    const heavy = new Set(['cricket-help','cricket-list','set-match','cricket-summary','cricket-tomorrow','cricket-settings']);
    if (heavy.has(name)) { const ok = await safeDefer(interaction, true); if (!ok) return; }

    // STOP/START
    if (name === 'stop') { data[g].is_paused = true; saveData(); return interaction.reply({ content:'⏸️ Bot activity paused. Use `/start` to resume.', ephemeral: true }).catch(()=>{}); }
    if (name === 'start'){ data[g].is_paused = false; saveData(); return interaction.reply({ content:'▶️ Bot activity resumed.', ephemeral: true }).catch(()=>{}); }

    // RESET
    if (name === 'cricket-reset') {
      data[g].filters = ['international','domestic'];
      data[g].gender_filters = ['men','women'];
      data[g].team_filters = [];
      saveData();
      return interaction.reply({ content:'🔄 Filters reset. Categories: `international, domestic`, Gender: `both`, Teams: `none`.', ephemeral: true }).catch(()=>{});
    }

    // HELP
    if (name === 'cricket-help') {
      const chunks = buildHelpChunks('/');
      await safeEdit(interaction, { content: chunks[0] });
      for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(()=>{});
      return;
    }

    // SETTINGS (panel)
    if (name === 'cricket-settings') {
      const embed = buildSettingsEmbed(cfg);
      const components = buildSettingsButtons(cfg);
      return safeEdit(interaction, { embeds: [embed], components });
    }

    if (name === 'cricket-channel') {
      const ch = interaction.options.getChannel('channel'); data[g].channel_id = ch.id; saveData();
      return interaction.reply({ content:`✅ Channel set to ${ch}.`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-filters') {
      const categories = interaction.options.getString('categories');
      const valid = new Set(['international','first-class','domestic','franchise']);
      const chosen = categories.split(',').map(s=>norm(s)).filter(s=>valid.has(s));
      if (chosen.length===0) return interaction.reply({ content:`❌ No valid categories. Choose from: ${[...valid].join(', ')}`, ephemeral: true }).catch(()=>{});
      data[g].filters = chosen; saveData();
      return interaction.reply({ content:`✅ Filters set: \`${chosen.join(', ')}\``, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-teams') {
      const action = interaction.options.getString('action'); const team = interaction.options.getString('team');
      const teams = new Set(data[g].team_filters || []);
      if (action==='clear') teams.clear();
      else if (action==='add'){ if(!team) return interaction.reply({content:'❌ Provide a team to add.', ephemeral:true}).catch(()=>{}); teams.add(team.trim()); }
      else if (action==='remove'){ if(!team) return interaction.reply({content:'❌ Provide a team to remove.', ephemeral:true}).catch(()=>{}); const target=[...teams].find(t=>t.toLowerCase()===team.trim().toLowerCase()); if(!target) return interaction.reply({content:'❌ That team is not in filters.', ephemeral:true}).catch(()=>{}); teams.delete(target); }
      data[g].team_filters=[...teams]; saveData();
      return interaction.reply({ content:`✅ Team filters: ${data[g].team_filters.join(', ') || 'none'}`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-gender') {
      const val = interaction.options.getString('value');
      data[g].gender_filters = (val==='both')? ['men','women'] : [val];
      saveData();
      return interaction.reply({ content:`✅ Gender filter set: \`${val}\`.`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-mode') {
      const mode = interaction.options.getString('mode'); data[g].mode = mode; saveData();
      return interaction.reply({ content:`✅ Mode set to \`${mode}\`.`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-daily-time') {
      const hhmm = interaction.options.getString('hhmm');
      if (!/^\d{4}$/.test(hhmm)) return interaction.reply({ content:'❌ Use 4 digits, e.g., 0930 or 2100.', ephemeral:true }).catch(()=>{});
      data[g].daily_time = hhmm; delete data[g][`next_summary_${g}`]; delete data[g][`fallback_summary_${g}`]; saveData();
      return interaction.reply({ content:`✅ Daily summary time set to \`${hhmm}\`.`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-status') {
      const ch = cfg.channel_id ? `<#${cfg.channel_id}>` : 'not set';
      const roles = (cfg.role_ids||[]).map(r=>`<@&${r}>`).join(', ') || 'none';
      const teams = (cfg.team_filters||[]).join(', ') || 'none';
      const genders = (cfg.gender_filters||['men','women']).join(', ');
      const paused = cfg.is_paused ? 'true' : 'false';
      return interaction.reply({ content:
        `**Paused:** \`${paused}\`\n**Mode:** \`${cfg.mode}\`\n**Channel:** ${ch}\n**Filters:** \`${(cfg.filters||[]).join(', ')}\`\n**Gender:** \`${genders}\`\n**Team filters:** \`${teams}\`\n**Selected (custom):** \`${(cfg.selected_match_ids||[]).join(', ') || 'none'}\`\n**Daily time:** \`${cfg.daily_time || DAILY_SUMMARY_HHMM}\`\n**Role pings:** \`${cfg.ping_enabled ? 'true' : 'false'}\`\n**Roles:** ${roles}`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-ping-toggle') {
      const enabled = interaction.options.getBoolean('enabled'); data[g].ping_enabled = enabled; saveData();
      return interaction.reply({ content:`✅ Role pings set to \`${enabled}\`.`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-ping-roles') {
      const action=interaction.options.getString('action'); const role=interaction.options.getRole('role');
      const roles=new Set(data[g].role_ids||[]); if(action==='add') roles.add(role.id); else roles.delete(role.id);
      data[g].role_ids=[...roles]; saveData();
      return interaction.reply({ content:`✅ Roles now: ${data[g].role_ids.map(r=>`<@&${r}>`).join(', ') || 'none'}`, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-ping-test') {
      const chId=cfg.channel_id; if(!chId) return interaction.reply({content:'❌ No channel configured. Use /cricket-channel first.', ephemeral:true}).catch(()=>{});
      const channel=await client.channels.fetch(chId).catch(()=>null); if(!channel) return interaction.reply({content:"❌ I can't see that channel. Check my permissions.", ephemeral:true}).catch(()=>{});
      const pingStr=mentionText(cfg)||'ℹ️ Pings are disabled or no roles set.'; await channel.send({content:pingStr, allowedMentions:{roles:cfg.role_ids||[], parse:[]}});
      return safeEdit(interaction, { content:'✅ Test sent.' });

    } else if (name === 'cricket-list') {
      const matches=(await getCurrentMatches())
        .filter(m=>categoryAllowed(m,(cfg.filters||[])))
        .filter(m=>genderAllowed(m,(cfg.gender_filters||['men','women'])))
        .filter(m=>teamAllowed(m,(cfg.team_filters||[])));
      if(matches.length===0) return safeEdit(interaction, { content:'No current matches for your filters (category/gender/team).' });

      const rows=matches.map(m=>{
        const id=matchIdOf(m); const nm=m.name||'Match'; const status=m.status||''; const series=m.series||'';
        const cat=guessCategory(m); const gen=guessGender(m);
        return `\`${id}\` • ${nm} • ${series} • ${cat} • ${gen} • ${status}`;
      });
      const header='**Current matches (copy IDs to select):**';
      const content=[header,...rows].join('\n'); const chunks=chunkText(content,1900);
      await safeEdit(interaction, { content:chunks[0] });
      for(let i=1;i<chunks.length;i++) await interaction.followUp({ content:chunks[i], ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-select') {
      const action=interaction.options.getString('action'); const mid=interaction.options.getString('match_id').trim();
      const sel=new Set(data[g].selected_match_ids||[]); if(action==='add') sel.add(mid); else sel.delete(mid);
      data[g].selected_match_ids=[...sel]; saveData();
      return interaction.reply({ content:`✅ Selection updated: \`${data[g].selected_match_ids.join(', ') || 'none'}\``, ephemeral: true }).catch(()=>{});

    } else if (name === 'cricket-setup') {
      const mode=interaction.options.getString('mode'); const ch=interaction.options.getChannel('channel');
      data[g].channel_id=ch.id; data[g].mode=mode; saveData();
      return interaction.reply({ content:`✅ Setup complete: mode \`${mode}\` in ${ch}.`, ephemeral: true }).catch(()=>{});

    } else if (name === 'set-match') {
      const category=interaction.options.getString('category'); const genderChoice=interaction.options.getString('gender');
      const channelOpt=interaction.options.getChannel('channel'); const teamOpt=interaction.options.getString('team');
      if(channelOpt){ data[g].channel_id=channelOpt.id; saveData(); }

      const current=await getCurrentMatches(); const todays=await getTodayMatches(); const byId={}; [...todays,...current].forEach(m=>byId[matchIdOf(m)]=m);
      let genderSet=cfg.gender_filters||['men','women']; if(genderChoice) genderSet=(genderChoice==='both')? ['men','women'] : [genderChoice];
      const tokens=[...(cfg.team_filters||[])]; if(teamOpt) tokens.push(teamOpt);

      const candidates=Object.values(byId).filter(m=> guessCategory(m)===category && isTodayOrLive(m) && genderAllowed(m,genderSet) && teamAllowed(m,tokens) );
      if(candidates.length===0){
        const friendlyTeams=(cfg.team_filters||[]).join(', ')||'any team'; const friendlyGender=genderSet.join(', ');
        return safeEdit(interaction, { content:`No **${category}** matches playing today that match filters.\nGender: \`${friendlyGender}\`, Teams: \`${friendlyTeams}${teamOpt? ' + '+teamOpt:''}\`` });
      }
      const options=candidates.slice(0,25).map(m=>({ label:(m.name||'Match').slice(0,100), description:`${m.series||''} • ${guessGender(m)} • ${m.status||''}`.slice(0,100), value:matchIdOf(m) }));
      const select=new StringSelectMenuBuilder().setCustomId('set_match_select').setPlaceholder('Select a match to track…').addOptions(options);
      const confirmBtn=new ButtonBuilder().setCustomId('set_match_confirm').setLabel('Confirm').setStyle(ButtonStyle.Success);
      const cancelBtn=new ButtonBuilder().setCustomId('set_match_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary);
      const row1=new ActionRowBuilder().addComponents(select); const row2=new ActionRowBuilder().addComponents(confirmBtn,cancelBtn);
      await safeEdit(interaction, { content:`Select a **${category}** match to track. Then click **Confirm**.`, components:[row1,row2] });

      const replyMsg = await interaction.fetchReply().catch(()=>null);
      if (!replyMsg) return;

      let selected=null; const collector=replyMsg.createMessageComponentCollector({ time:180000 });
      collector.on('collect', async (i)=>{
        if(i.user.id!==interaction.user.id) return i.reply({ content:'This selection isn’t for you.', ephemeral: true }).catch(()=>{});
        if(i.customId==='set_match_select'){ selected=i.values[0]; await i.update({ content:`Chosen match ID: \`${selected}\`. Click **Confirm** to proceed.`, components:[row1,row2] }).catch(()=>{}); }
        else if(i.customId==='set_match_confirm'){ collector.stop('confirm'); await i.deferUpdate().catch(()=>{}); }
        else if(i.customId==='set_match_cancel'){ collector.stop('cancel'); await i.deferUpdate().catch(()=>{}); }
      });
      collector.on('end', async (_,_reason)=>{
        if(_reason==='confirm' && selected){
          const sel=new Set(data[g].selected_match_ids||[]); sel.add(selected); data[g].selected_match_ids=[...sel]; data[g].mode='custom'; saveData();
          const chDisp=data[g].channel_id? `<#${data[g].channel_id}>` : 'not set';
          await safeEdit(interaction, { content:`✅ Tracking set for match \`${selected}\` in ${chDisp}.\nMode switched to **custom**. I’ll post embedded scorecards every ${Math.floor(POLL_SECONDS/60)} min.`, components:[] });
        } else if (_reason==='cancel'){ await safeEdit(interaction, { content:'Cancelled.', components:[] }); }
        else { await safeEdit(interaction, { content:'Timed out. Run \`/set-match\` again.', components:[] }); }
      });

    } else if (name === 'cricket-summary') {
      const mid=interaction.options.getString('match_id').trim();
      try{
        const sc=await fetchScorecard(mid);
        if(!sc || (!sc.scorecard && !sc.score)) return safeEdit(interaction, { content:'❌ Scorecard not available for that match ID (yet).' });
        const embeds=scorecardEmbedsFrom(sc);
        if(embeds.length<=10) return safeEdit(interaction, { content:'📋 Scorecard:', embeds }, false);
        await safeEdit(interaction, { content:'📋 Scorecard (part 1):', embeds:embeds.slice(0,10) }, false);
        for(let i=10;i<embeds.length;i+=10) await interaction.followUp({ content:`📋 Scorecard (part ${Math.floor(i/10)+1}):`, embeds:embeds.slice(i,i+10) }).catch(()=>{});
      }catch(e){ console.error('[cricket-summary]', e); return safeEdit(interaction, { content:'⚠️ Failed to fetch scorecard. Try again in a minute.' }); }

    } else if (name === 'cricket-tomorrow') {
      const matches=await getMatchesForISOSafe(tomorrowISO());
      const chunks=formatTomorrowList(matches, cfg.gender_filters||['men','women'], cfg.team_filters||[]);
      await safeEdit(interaction, { content:chunks[0] });
      for(let i=1;i<chunks.length;i++) await interaction.followUp({ content:chunks[i], ephemeral: true }).catch(()=>{});
    }

  }catch(e){
    console.error(e);
    try{ if (!interaction.deferred && !interaction.replied) await interaction.reply({ content:'⚠️ Something went wrong.', ephemeral:true }); }catch{}
  }
});

// ---------- ERROR GUARDS ----------
process.on('unhandledRejection', (err)=>{ console.error('[unhandledRejection]', err); });
client.on('error', (err)=>{ console.error('[client error]', err); });

// ---------- LOGIN ----------
if(!DISCORD_TOKEN || !CRICKET_API_KEY){
  console.error('ERROR: Set DISCORD_TOKEN and CRICKET_API_KEY in your .env file.');
  process.exit(1);
}
client.login(DISCORD_TOKEN);
