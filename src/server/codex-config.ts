const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'image_generation', 'view_image', 'skill_search', 'skill_mcp_dependency_install', 'hooks', 'memories', 'goals', 'sleep_tool', 'tool_suggest', 'code_mode', 'code_mode_host', 'workspace_dependencies']

export function toolDisabledCodexConfig(): Record<string, unknown> {
  return {
    web_search: 'disabled', 'tools.update_plan.enabled': false,
    'tools.experimental_request_user_input.enabled': false, 'agents.enabled': false,
    'apps._default.enabled': false, project_doc_max_bytes: 0,
    ...Object.fromEntries(DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
  }
}
