import { QuCrypto } from '@qu/core';
import { THREAD_PRESETS } from './thread-service.js';

/**
 * CHAT SERVICE — group-chat creation and discovery on top of ThreadService.
 *
 * A 1:1 room needs no discovery step: its id is DERIVED from both members'
 * pubkeys (see this class's `roomId()`), so either side lands in
 * the same room with Contacts as the mutual-interest signal. A GROUP's id
 * is arbitrary (there's no deterministic function of an open-ended member
 * list two people would independently compute the same way), so an
 * invited member needs to be TOLD it exists.
 *
 * The delivery mechanism reuses THREAD_PRESETS.mail exactly as-is: every
 * identity gets its own private "chat invites" mailbox
 * (`chat-invites-<pub>`, readers: [that identity] - anyone can write,
 * only the owner can read, same shape apps/inbox already uses for actual
 * mail). Creating a group posts one invite message into each OTHER
 * member's mailbox; `listMyGroups()` reads this identity's own mailbox for
 * the group ids it's been told about. The group's actual name/membership
 * always comes from the group thread's own config (via
 * `threads.getConfig()`), never from the invite - the invite is only ever
 * used for "which group ids do I belong to", not as a second source of
 * truth for the group's metadata.
 */
export class ChatService {
  static SPACE = 'chat';
  static #INVITE_THREAD_ID = 'groups';

  /**
   * A deterministic 1:1/group room id both members derive independently,
   * order-independent - pure function of the member set, no identity/thread
   * state needed, hence static. Moved here (from apps/chat/client.js, which
   * used to call `@qu/core`'s `QuCrypto` directly) so an App never has to
   * reach past its Service layer for a plain hash derivation.
   * @param {string[]} memberPubs
   * @returns {Promise<string>}
   */
  static async roomId(memberPubs) {
    const sorted = [...memberPubs].sort();
    const hash = await QuCrypto.sha256(new TextEncoder().encode(sorted.join(',')));
    return `r-${QuCrypto.toHex(hash).slice(0, 32)}`;
  }

  /**
   * @param {ThreadService} threads
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   */
  constructor(threads, identityEngine) {
    this.threads = threads;
    this.identity = identityEngine;
  }

  static #inviteSpace(actorPub) {
    return `chat-invites-${actorPub}`;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * @param {{name: string, memberPubs: string[]}} params - `memberPubs` are
   *   the OTHER members; this identity is added automatically.
   * @returns {Promise<{groupId: string, name: string, memberPubs: string[]}>}
   */
  async createGroup({ name, memberPubs }) {
    const myPub = await this.#myActorPub();
    const allMembers = [...new Set([myPub, ...memberPubs])];
    const groupId = `g-${globalThis.crypto.randomUUID()}`;

    await this.threads.createThread(ChatService.SPACE, groupId, THREAD_PRESETS.group(allMembers, name));

    await Promise.all(allMembers.filter((pub) => pub !== myPub).map(async (theirPub) => {
      const inviteSpace = ChatService.#inviteSpace(theirPub);
      await this.threads.createThread(inviteSpace, ChatService.#INVITE_THREAD_ID, THREAD_PRESETS.mail(theirPub));
      await this.threads.postMessage(inviteSpace, ChatService.#INVITE_THREAD_ID, {
        body: name,
        extra: { type: 'group-invite', groupId, name, memberPubs: allMembers },
      });
    }));

    return { groupId, name, memberPubs: allMembers };
  }

  /**
   * @returns {Promise<string[]>} Every group id this identity has ever been
   *   invited to. Membership is fixed at creation (see
   *   THREAD_PRESETS.group's doc comment), so this only ever grows.
   */
  async listMyGroups() {
    const myPub = await this.#myActorPub();
    const inviteSpace = ChatService.#inviteSpace(myPub);
    await this.threads.createThread(inviteSpace, ChatService.#INVITE_THREAD_ID, THREAD_PRESETS.mail(myPub));
    const invites = await this.threads.listMessages(inviteSpace, ChatService.#INVITE_THREAD_ID);

    const groupIds = new Set();
    for (const invite of invites) {
      if (invite.type === 'group-invite' && invite.groupId) groupIds.add(invite.groupId);
    }
    return [...groupIds];
  }

  /** @returns {string} The space this identity's own group invites live under - for `subscribe()`. */
  async myInviteSpace() {
    return ChatService.#inviteSpace(await this.#myActorPub());
  }
}
