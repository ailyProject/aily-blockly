import {
  LexOwnerFacade,
  type LexOwnerContext,
} from '../helpers/lex-stream.helper';

export type {
  LexOwnerContext,
};

export interface LexOwnerRuntimeFactory {
  create(context: LexOwnerContext): LexOwnerFacade;
}

export function createLexOwnerRuntime(context: LexOwnerContext): LexOwnerFacade {
  return new LexOwnerFacade(context);
}

export const defaultLexOwnerRuntimeFactory: LexOwnerRuntimeFactory = {
  create: createLexOwnerRuntime,
};
