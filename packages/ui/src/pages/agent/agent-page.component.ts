import { Chat } from '@ai-sdk/angular'
import { Component, computed, signal } from '@angular/core'
import { HlmBadgeImports } from '@spartan-ng/helm/badge'
import { HlmButtonImports } from '@spartan-ng/helm/button'
import { HlmCardImports } from '@spartan-ng/helm/card'
import { HlmTextareaImports } from '@spartan-ng/helm/textarea'
import { injectAgentApi } from '@ui/agent-api'
import { createAgentChatTransport } from '@ui/agent-api/chat-transport'
import { AppShellComponent } from '@ui/layout/app-shell.component'
import { demoAgentRequestBody } from '@ui/pages/agent/agent-page.data'

@Component({
	selector: 'agent-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmTextareaImports],
	templateUrl: './agent-page.component.html',
	styleUrl: './agent-page.component.css'
})
export class AgentPageComponent {
	private readonly agentApi = injectAgentApi()

	protected readonly draft = signal('Summarize the current core migration shape in 3 short bullets.')
	protected readonly chat = new Chat({
		id: 'agent-page-demo',
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
				body: demoAgentRequestBody
			}
		)
	}

	protected async resume() {
		await this.chat.resumeStream({
			body: demoAgentRequestBody
		})
	}
}
