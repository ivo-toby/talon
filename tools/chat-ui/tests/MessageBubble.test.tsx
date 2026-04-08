import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from '../src/components/MessageBubble';

function textParts(text: string) {
  return [{ type: 'text' as const, text }];
}

describe('MessageBubble', () => {
  it('renders user message on the right', () => {
    const { container } = render(<MessageBubble role="user" parts={textParts('Hello')} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain('items-end');
  });

  it('renders assistant message on the left', () => {
    const { container } = render(<MessageBubble role="assistant" parts={textParts('Hi there')} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain('items-start');
  });

  it('renders bold markdown in assistant messages', () => {
    render(<MessageBubble role="assistant" parts={textParts('This is **bold**')} />);
    const strong = document.querySelector('strong');
    expect(strong?.textContent).toBe('bold');
  });

  it('escapes HTML in content to prevent XSS', () => {
    render(<MessageBubble role="assistant" parts={textParts('<script>alert("xss")</script>')} />);
    const script = document.querySelector('script');
    expect(script).toBeNull();
    // Should be escaped, not rendered as a script tag
    expect(document.body.innerHTML).toContain('&lt;script&gt;');
  });
});
