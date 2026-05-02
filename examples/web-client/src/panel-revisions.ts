export type PanelName = "action" | "ownPosts" | "search";

export interface PanelRequest<Client> {
  readonly client: Client;
  readonly generation: number;
  readonly panel: PanelName;
  readonly panelRevision: number;
}

export class PanelRevisionTracker<Client> {
  #ownPostsRevision = 0;
  #searchRevision = 0;
  #actionRevision = 0;

  current(panel: PanelName): number {
    if (panel === "ownPosts") return this.#ownPostsRevision;
    if (panel === "search") return this.#searchRevision;
    return this.#actionRevision;
  }

  markRendered(panel: PanelName): number {
    if (panel === "ownPosts") {
      this.#ownPostsRevision += 1;
      return this.#ownPostsRevision;
    }
    if (panel === "search") {
      this.#searchRevision += 1;
      return this.#searchRevision;
    }
    this.#actionRevision += 1;
    return this.#actionRevision;
  }

  beginRequest(panel: PanelName, client: Client, generation: number): PanelRequest<Client> {
    return {
      client,
      generation,
      panel,
      panelRevision: this.markRendered(panel),
    };
  }

  canHydrate(panel: PanelName, capturedRevision: number): boolean {
    return this.current(panel) === capturedRevision;
  }

  isCurrentRequest(
    request: PanelRequest<Client>,
    activeClient: Client | undefined,
    currentGeneration: number,
  ): boolean {
    return (
      request.client === activeClient &&
      request.generation === currentGeneration &&
      this.current(request.panel) === request.panelRevision
    );
  }
}
