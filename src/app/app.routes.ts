import { Routes } from '@angular/router';

export const routes: Routes = [
    {
        path: '',
        redirectTo: 'main',
        pathMatch: 'full'
    },
    {
        path: 'main',
        loadComponent: () => import('./main-window/main-window.component').then(m => m.MainWindowComponent)
    },
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
        path: "aily-chat",
        loadComponent: () => import('./tools/aily-chat/aily-chat.component').then(m => m.AilyChatComponent)
    },
    {
        path: "code-viewer",
        loadComponent: () => import('./tools/code-viewer/code-viewer.component').then(m => m.CodeViewerComponent)
    }
];
