import type {
  EngineEventEnvelope,
  HarnessConversationEntry,
  HarnessMessage,
  HarnessSnapshot,
  HarnessStreamEvent,
} from "../types";

/** 按时间排列的一段主控对话回合：用户消息开启，条目与 assistant 消息归属最近的用户消息。 */
export type ConversationTurn = {
  /** 回合标识，即开启该回合的用户消息 ID。 */
  turnId: string;
  /** 开启回合的用户消息。 */
  user: HarnessMessage;
  /** 该 turnId 下按 seq 升序排列的耐久对话条目（正文/思考/工具）。 */
  entries: HarnessConversationEntry[];
  /** 回合结束后的完整 assistant 消息；回合中断或未结束时为 null。 */
  assistant: HarnessMessage | null;
};

/** Engine 事件流的序号跟踪状态；generation 变化表示 Engine 已重启，序号重新计数。 */
export type StreamTracker = {
  /** 最近一次接受的事件帧所属 generation。 */
  generation: number;
  /** 已消费的最后一个 frame seq；初始 0 表示尚未消费任何帧。 */
  lastSeq: number;
};

/** 创建尚未消费任何帧的事件跟踪器。 */
export function createStreamTracker(): StreamTracker {
  return { generation: -1, lastSeq: 0 };
}

/**
 * 判定一帧 Engine 事件如何处理。
 * - "skip"：重复或乱序旧帧，直接忽略。
 * - "apply"：严格连续帧，可增量合并进当前快照。
 * - "resync"：generation 变化或序号跳帧，调用方必须重读权威快照；tracker 已对齐到该帧，
 *   之后到达的连续帧可继续增量合并（重读快照耐久包含该帧效果）。
 */
export function acceptEnvelope(
  tracker: StreamTracker,
  envelope: EngineEventEnvelope,
): "apply" | "skip" | "resync" {
  const seq = envelope.frame.seq;
  if(envelope.generation<tracker.generation)return "skip";
  if (envelope.generation !== tracker.generation) {
    tracker.generation = envelope.generation;
    tracker.lastSeq = seq;
    return "resync";
  }
  if (seq <= tracker.lastSeq) return "skip";
  if (seq === tracker.lastSeq + 1) {
    tracker.lastSeq = seq;
    return "apply";
  }
  tracker.lastSeq = seq;
  return "resync";
}

/**
 * 把一条 Harness 流事件增量合并进快照副本；条目先耐久后发布，事件与快照永远同源。
 * turn_finished/turn_interrupted/execution_changed 不改变 conversationEntries，
 * 原样返回，由调用方触发一次快照重读以获取 assistant 消息与状态。
 */
export function applyHarnessEventToSnapshot(
  snapshot: HarnessSnapshot,
  event: HarnessStreamEvent,
): HarnessSnapshot {
  if(event.snapshotSequence!==undefined){
    if((snapshot.snapshotSequence??0)>=event.snapshotSequence)return snapshot;
    snapshot={...snapshot,snapshotSequence:event.snapshotSequence};
  }
  switch (event.type) {
    case "entry_started": {
      if (
        snapshot.conversationEntries.some(
          (entry) => entry.entryId === event.entry.entryId,
        )
      )
        return snapshot;
      // 事件按 Journal 顺序到达，直接追加；跨回合展示顺序由 composeConversationTurns 归组保证。
      return { ...snapshot, conversationEntries: [...snapshot.conversationEntries, event.entry] };
    }
    case "entry_appended": {
      let changed = false;
      const conversationEntries = snapshot.conversationEntries.map((entry) => {
        if (entry.entryId !== event.entryId) return entry;
        changed = true;
        if (entry.kind === "body" || entry.kind === "thought") {
          return {
            ...entry,
            text: entry.text + event.text,
            truncated: entry.truncated || event.truncated,
          };
        }
        return {
          ...entry,
          output: (entry.output ?? "") + event.text,
          outputTruncated: entry.outputTruncated || event.truncated,
        };
      });
      return changed ? { ...snapshot, conversationEntries } : snapshot;
    }
    case "entry_finished": {
      if (
        !snapshot.conversationEntries.some(
          (entry) => entry.entryId === event.entry.entryId,
        )
      )
        return snapshot;
      return {
        ...snapshot,
        conversationEntries: snapshot.conversationEntries.map((entry) =>
          entry.entryId === event.entry.entryId ? event.entry : entry,
        ),
      };
    }
    default:
      return snapshot;
  }
}

/**
 * 把 messages 与 conversationEntries 组装为按时间排列的回合数组。
 * 遍历 messages：user 消息开启新回合，后续 assistant 消息归属当前回合；
 * 每个回合挂载同 turnId 的条目（按 seq 升序）。没有任何用户消息归属的孤儿条目被忽略。
 */
export function composeConversationTurns(
  harness: HarnessSnapshot,
): ConversationTurn[] {
  const entriesByTurn = new Map<string, HarnessConversationEntry[]>();
  for (const entry of harness.conversationEntries) {
    const bucket = entriesByTurn.get(entry.turnId);
    if (bucket) bucket.push(entry);
    else entriesByTurn.set(entry.turnId, [entry]);
  }
  const turns: ConversationTurn[] = [];
  for (const message of harness.messages) {
    if(message.summaryKey)continue; // 总结在独立回合显示，不覆盖最近用户回答。
    if (message.role === "user") {
      turns.push({ turnId: message.id, user: message, entries: [], assistant: null });
    } else if (turns.length > 0) {
      turns[turns.length - 1].assistant = message;
    }
  }
  for(const obligation of harness.impactSummaries??[]){
    const turnId=obligation.turnId??`summary:${obligation.key}`;
    const assistant=obligation.status==="completed"?harness.messages.find(item=>item.id===obligation.messageId)??null:null;
    const summaryTurnIds=[...entriesByTurn.keys()].filter(id=>id===`summary:${obligation.key}`||id.startsWith(`summary:${obligation.key}:`));
    if(!summaryTurnIds.includes(turnId))summaryTurnIds.push(turnId);
    for(const id of summaryTurnIds){const startedAt=entriesByTurn.get(id)?.[0]?.startedAt??obligation.createdAt;turns.push({turnId:id,user:{id,role:"user",summaryKey:obligation.key,text:id===turnId?"自动影响面总结":"影响面总结（原中断回合）",createdAt:startedAt},entries:[],assistant:id===turnId?assistant:null});}
  }
  for (const turn of turns) {
    turn.entries = (entriesByTurn.get(turn.turnId) ?? [])
      .slice()
      .sort((a, b) => a.seq - b.seq);
  }
  return turns.sort((a,b)=>a.user.createdAt.localeCompare(b.user.createdAt));
}

/** 总结首次非空耐久正文的显示时间；思考/工具/义务建立都不能提前显示结果卡。 */
export function summaryBodyStartedAt(harness:HarnessSnapshot,key:string):string|null {
  const obligation=harness.impactSummaries?.find(item=>item.key===key);
  if(!obligation)return null;
  const prefix=`summary:${key}`;
  const body=harness.conversationEntries.find(entry=>entry.kind==="body"&&entry.text.trim()&&(entry.turnId===prefix||entry.turnId.startsWith(`${prefix}:`)));
  if(body)return body.startedAt;
  const message=obligation.status==="completed"?harness.messages.find(item=>item.id===obligation.messageId):undefined;
  return message?.text.trim()?message.createdAt:null;
}

/**
 * 回合没有任何正文条目但存在完整 assistant 消息时为 true：
 * 此时渲染 assistant 消息气泡；有正文条目时正文已覆盖回答，不重复渲染。
 */
export function turnNeedsAssistantFallback(turn: ConversationTurn): boolean {
  return (
    turn.assistant !== null &&
    !turn.entries.some((entry) => entry.kind === "body")
  );
}
