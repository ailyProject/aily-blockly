/// <reference lib="webworker" />

interface ParseProjectAbiRequest {
  id: number;
  content: string;
}

interface ParseProjectAbiResponse {
  id: number;
  data?: any;
  error?: string;
}

addEventListener('message', (event: MessageEvent<ParseProjectAbiRequest>) => {
  const { id, content } = event.data;
  const response: ParseProjectAbiResponse = { id };

  try {
    response.data = JSON.parse(content);
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }

  postMessage(response);
});
