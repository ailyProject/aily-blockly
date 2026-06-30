export class ChatActionContributionRegistry<
  TOwnerId extends string,
  TContribution extends { readonly ownerId: TOwnerId },
> {
  private readonly contributions: TContribution[] = [];

  appendMany(contributions: readonly TContribution[]): void {
    this.contributions.push(...contributions);
  }

  readByOwner(ownerId: TOwnerId): readonly TContribution[] {
    return this.contributions.filter(contribution => contribution.ownerId === ownerId);
  }

  clear(): void {
    this.contributions.length = 0;
  }
}