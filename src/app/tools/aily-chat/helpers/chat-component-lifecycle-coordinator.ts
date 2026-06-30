export class ChatComponentLifecycleCoordinator {
  constructor(
    private readonly deps: {
      isHostInitialized: () => boolean;
      initializeHost: () => void;
      loadMermaid: () => Promise<{ default?: any } | any>;
      setMermaidInstance: (instance: any) => void;
      initializeEngine: () => void;
      detachEngineView: () => void;
    },
  ) {}

  initialize(): void {
    if (!this.deps.isHostInitialized()) {
      this.deps.initializeHost();
    }

    void this.deps.loadMermaid().then((mermaidModule) => {
      this.deps.setMermaidInstance(mermaidModule?.default ?? mermaidModule);
    });

    this.deps.initializeEngine();
  }

  detachView(): void {
    this.deps.detachEngineView();
  }
}
