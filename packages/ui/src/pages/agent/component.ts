import { Chat } from '@ai-sdk/angular'
import { Component, computed, signal } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmTextareaImports } from 'spartan/textarea'

import { AppShellComponent } from '@/layout/app-shell.component'
import { agentRequestSeed } from '@/pages/agent/data'
import { createAgentChatTransport, injectAgentApi } from '@/utils/chat'

@Component({
	selector: 'agent-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmTextareaImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class AgentPageComponent {
	private readonly agentApi = injectAgentApi()

	protected readonly draft = signal('Summarize the current core migration shape in 3 short bullets.')
	protected readonly chat = new Chat({
		id: 'agent-page-session',
		transport: createAgentChatTransport({ api: this.agentApi.api })
	})
	protected readonly canSend = computed(() => this.draft().trim().length > 0 && this.chat.status === 'ready')

	protected async send() {
		const text = this.draft().trim()
		if (!text) return

		this.draft.set('')
		await this.chat.sendMessage(
			{ text },
			{
				body: agentRequestSeed
			}
		)
	}

	protected async resume() {
		await this.chat.resumeStream({
			body: agentRequestSeed
		})
	}
}
