import { Routes } from '@angular/router';
import { projectEntryGuard } from './guards/project-entry.guard';

export const routes: Routes = [
    {
        path: '',
        redirectTo: 'main',
        pathMatch: 'full'
    },
    {
        path: 'main',
        loadComponent: () => import('./main-window/main-window.component').then(m => m.MainWindowComponent),
        children: [
            {
                path: '',
                redirectTo: 'guide',
                pathMatch: 'full'
            },
            {
                path: 'guide',
                loadComponent: () => import('./pages/guide/guide.component').then(m => m.GuideComponent)
            },
            {
                path: 'project-new',
                loadComponent: () => import('./pages/project-new/project-new.component').then(m => m.ProjectNewComponent)
            },
            {
                path: 'playground',
                loadComponent: () => import('./pages/playground/playground.component').then(m => m.PlaygroundComponent),
                children: [
                    {
                        path: '',
                        redirectTo: 'list',
                        pathMatch: 'full'
                    },
                    {
                        path: 'list',
                        loadComponent: () => import('./pages/playground/example-list/example-list.component').then(m => m.ExampleListComponent)
                    },
                    {
                        path: 's/:name',
                        loadComponent: () => import('./pages/playground/subject-item/subject-item.component').then(m => m.SubjectItemComponent)
                    }
                ]
            },
            {
                path: 'blockly-editor',
                canActivate: [projectEntryGuard],
                loadComponent: () => import('./editors/blockly-editor/blockly-editor.component').then(m => m.BlocklyEditorComponent)
            },
            {
                path: 'code-editor',
                canActivate: [projectEntryGuard],
                loadComponent: () => import('./editors/code-editor/code-editor.component').then(m => m.CodeEditorComponent)
            },
            {
                path: 'code-editor-pro',
                canActivate: [projectEntryGuard],
                loadComponent: () => import('./editors/code-editor-pro/code-editor-pro.component').then(m => m.CodeEditorProComponent)
            }
        ]
    },
    // {
    //     path: 'ai-manager',
    //     loadComponent: () => import('./pages/ai-manager/ai-manager.component').then(m => m.AiManagerComponent)
    // },
    // {
    //     path:"sub",
    //     loadComponent: () => import('./sub-window/sub-window.component').then(m => m.SubWindowComponent)
    // },
    {
        path: "project-new",
        loadComponent: () => import('./windows/project-new/project-new.component').then(m => m.ProjectNewComponent)
    },
    {
        path: "settings",
        loadComponent: () => import('./windows/settings/settings.component').then(m => m.SettingsComponent)
    },
    {
        path: "about",
        loadComponent: () => import('./windows/about/about.component').then(m => m.AboutComponent)
    },
    {
        path: "serial-monitor",
        loadComponent: () => import('./tools/serial-monitor/serial-monitor.component').then(m => m.SerialMonitorComponent)
    },
    {
        path: "mqtt-debugger",
        redirectTo: "child-tool/mqtt-debugger",
        pathMatch: "full"
    },
    {
        path: "network-debugger",
        redirectTo: "child-tool/network-debugger",
        pathMatch: "full"
    },
    {
        path: "industrial-bus-debugger",
        redirectTo: "child-tool/industrial-bus-debugger",
        pathMatch: "full"
    },
    {
        path: "child-tool/aily-chat",
        data: { childToolId: 'aily-chat' },
        loadComponent: () => import('./tools/child-tool-host/child-tool-host.component').then(m => m.ChildToolHostComponent)
    },
    {
        path: "child-tool/:toolId",
        loadComponent: () => import('./tools/child-tool-host/child-tool-host.component').then(m => m.ChildToolHostComponent)
    },
    {
        path: "ble-debugger",
        redirectTo: "child-tool/ble-debugger",
        pathMatch: "full"
    },
    {
        path: "ffs-manager-child",
        redirectTo: "child-tool/ffs-manager-child",
        pathMatch: "full"
    },
    {
        path: "code-viewer",
        loadComponent: () => import('./editors/blockly-editor/tools/code-viewer/code-viewer.component').then(m => m.CodeViewerComponent)
    },
    {
        path: "iframe",
        loadComponent: () => import('./windows/iframe/iframe.component').then(m => m.IframeComponent)
    },
    {
        path: "graph-editor",
        loadComponent: () => import('./editors/graph-editor/graph-editor.component').then(m => m.GraphEditorComponent)
    },
];
