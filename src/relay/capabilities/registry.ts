export interface CapabilityResponse {
  ok: true;
  message: string;
  path?: string;
}

export type CapabilityHandler = (body: unknown) => Promise<CapabilityResponse>;

export interface CapabilityDefinition {
  name: string;
  handle: CapabilityHandler;
  helperCommand?: string;
  instructions?: string;
}

export class CapabilityRegistry {
  private readonly definitions: CapabilityDefinition[] = [];

  register(definition: CapabilityDefinition): void {
    if (this.definitions.some((existing) => existing.name === definition.name)) {
      throw new Error(`Capability already registered: ${definition.name}`);
    }
    this.definitions.push(definition);
  }

  list(): CapabilityDefinition[] {
    return [...this.definitions];
  }

  instructions(): string | undefined {
    const sections = this.definitions.map((definition) => definition.instructions).filter((section): section is string => Boolean(section?.trim()));
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }
}
