/**
 * Unit tests for formatToolCall utility.
 */

import { describe, it, expect } from 'vitest';
import { formatToolCall } from '../../../src/daemon/tool-name-formatter.js';

describe('formatToolCall', () => {
  describe('MCP tools', () => {
    it('formats Google Calendar tool with gcal prefix stripped', () => {
      expect(formatToolCall('mcp__claude_ai_Google_Calendar__gcal_create_event')).toBe(
        '📅 Using Google Calendar: create event',
      );
    });

    it('formats Brave Search tool with brave prefix stripped', () => {
      expect(formatToolCall('mcp__brave-search__brave_web_search')).toBe(
        '🌐 Using Brave Search: web search',
      );
    });

    it('formats Notes Search tool without stripping', () => {
      expect(formatToolCall('mcp__notes-search__semantic_search')).toBe(
        '🔍 Using Notes Search: semantic search',
      );
    });

    it('formats Atlassian tool with camelCase tool name', () => {
      expect(formatToolCall('mcp__claude_ai_Atlassian__createJiraIssue')).toBe(
        '🗂️ Using Atlassian: create Jira Issue',
      );
    });

    it('formats Filesystem tool', () => {
      expect(formatToolCall('mcp__filesystem__read_file')).toBe(
        '📁 Using Filesystem: read file',
      );
    });

    it('formats unknown MCP server with generic emoji', () => {
      expect(formatToolCall('mcp__custom-server__do_something')).toBe(
        '🔧 Using Custom Server: do something',
      );
    });

    it('formats GitHub MCP tool', () => {
      expect(formatToolCall('mcp__github__create_pull_request')).toBe(
        '🐙 Using GitHub: create pull request',
      );
    });

    it('formats Slack MCP tool', () => {
      expect(formatToolCall('mcp__slack__send_message')).toBe(
        '💬 Using Slack: send message',
      );
    });

    it('formats Gmail MCP tool', () => {
      expect(formatToolCall('mcp__gmail__send_email')).toBe(
        '📧 Using Gmail: send email',
      );
    });

    it('formats Jira MCP tool via atlassian pattern', () => {
      expect(formatToolCall('mcp__jira__create_issue')).toBe(
        '🗂️ Using Atlassian: create issue',
      );
    });

    it('formats Confluence MCP tool via atlassian pattern', () => {
      expect(formatToolCall('mcp__confluence__get_page')).toBe(
        '🗂️ Using Atlassian: get page',
      );
    });

    it('formats memory MCP server', () => {
      expect(formatToolCall('mcp__memory__store')).toBe(
        '💾 Using Memory: store',
      );
    });
  });

  describe('native tools', () => {
    it('formats memory_access with memory emoji', () => {
      expect(formatToolCall('memory_access')).toBe('💾 Using Memory Access');
    });

    it('formats background_agent with robot emoji', () => {
      expect(formatToolCall('background_agent')).toBe('🤖 Using Background Agent');
    });

    it('formats channel_send with chat emoji', () => {
      expect(formatToolCall('channel_send')).toBe('💬 Using Channel Send');
    });

    it('formats unknown native tool with wrench emoji', () => {
      expect(formatToolCall('some_unknown_tool')).toBe('🔧 Using Some Unknown Tool');
    });

    it('formats single-word tool', () => {
      expect(formatToolCall('ping')).toBe('🔧 Using Ping');
    });
  });
});
