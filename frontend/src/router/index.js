import { createRouter, createWebHistory } from 'vue-router'
import pb from '@/lib/pocketbase'
import { authState, homePath, resolveNavigation } from '../lib/access.js'
import { browserSessionStorage, rememberQueueTransition } from '@/lib/queueReturn'
import { carryTodoReturn, todoReturnTarget } from '@/lib/unifiedTodos'

function getAuthState() {
  return authState({ isValid: pb.authStore.isValid, model: pb.authStore.model })
}

// 登录后该去哪里
function getHomePath() {
  return homePath(getAuthState())
}

const routes = [
  {
    path: '/account/security',
    name: 'AccountSecurity',
    component: () => import('@/views/AccountSecurityView.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/account/:action(recover|reset-password|confirm-email|verify-email)',
    name: 'AccountAction',
    component: () => import('@/views/AccountActionView.vue'),
    meta: { allowInitialPassword: true }
  },
  {
    path: '/workspace',
    name: 'WorkspaceHome',
    component: () => import('@/views/WorkspaceHomeView.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/',
    redirect: () => getHomePath()
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guest: true }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { guest: true }
  },
  {
    path: '/change-password',
    name: 'ChangeInitialPassword',
    component: () => import('@/views/ChangeInitialPasswordView.vue'),
    meta: { requiresAuth: true, allowInitialPassword: true }
  },
  {
    path: '/admin',
    component: () => import('@/views/admin/AdminLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'AdminDashboard',
        component: () => import('@/views/admin/DashboardView.vue')
      },
      {
        path: 'todos',
        name: 'AdminTodos',
        component: () => import('@/views/admin/UnifiedTodosView.vue')
      },
      {
        path: 'projects/new',
        name: 'NewProject',
        component: () => import('@/views/admin/NewProjectView.vue')
      },
      {
        path: 'guide/project-files',
        name: 'ProjectFilesGuide',
        component: () => import('@/views/admin/ProjectFilesGuideView.vue')
      },
      {
        path: 'projects/:id',
        name: 'ProjectDetail',
        component: () => import('@/views/admin/ProjectDetailView.vue')
      },
      {
        path: 'projects/:id/batch-reports/:batchId',
        name: 'ProjectBatchReport',
        component: () => import('@/views/admin/BatchReportView.vue')
      },
      {
        path: 'projects/:id/deliveries',
        name: 'ProjectDeliveries',
        component: () => import('@/views/admin/DeliveriesView.vue')
      },
      {
        path: 'projects/:id/settings',
        name: 'ProjectSettings',
        component: () => import('@/views/admin/ProjectSettingsView.vue')
      },
      {
        path: 'projects/:id/verification',
        name: 'SourceFidelity',
        component: () => import('@/views/admin/SourceFidelityView.vue')
      },
      {
        path: 'projects/:id/adoption',
        name: 'ProjectAdoption',
        component: () => import('@/views/admin/AdoptionView.vue')
      },
      {
        path: 'creator-grants',
        name: 'CreatorGrants',
        component: () => import('@/views/admin/CreatorGrantsView.vue')
      },
      {
        path: 'sources',
        name: 'SourceRegistry',
        component: () => import('@/views/admin/SourcesView.vue')
      },
      {
        path: 'gate-rules',
        name: 'GateRules',
        component: () => import('@/views/admin/GateRulesView.vue')
      },
      {
        path: 'projects/:projectId/arbitration/:pageId',
        name: 'Arbitration',
        component: () => import('@/views/admin/ArbitrationView.vue')
      }
    ]
  },
  {
    path: '/tasks',
    component: () => import('@/views/proofreader/ProofreaderLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'TaskHall',
        component: () => import('@/views/proofreader/TaskHallView.vue')
      },
      {
        path: 'problems',
        name: 'MyProblems',
        component: () => import('@/views/proofreader/MyProblemsView.vue')
      },
      {
        path: 'profile',
        name: 'ProofreaderProfile',
        component: () => import('@/views/proofreader/ProfileView.vue')
      },
      {
        path: ':id/edit',
        name: 'ProofreadEditor',
        component: () => import('@/views/proofreader/ProofreadEditorView.vue')
      }
    ]
  },
  {
    path: '/projects',
    name: 'ProjectDiscovery',
    component: () => import('@/views/ProjectDiscoveryView.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.path === from.path) return false
    return { left: 0, top: 0 }
  }
})

// ✅ 修复核心：直接用 pb.authStore 判断（不是 store）
router.beforeEach((to, from) => {
  const destination = resolveNavigation(to, getAuthState())
  if (destination) return destination
  const withReturn = carryTodoReturn(to, from)
  if (withReturn) return withReturn
  const todoReturn = from.name === 'AdminTodos' && todoReturnTarget(to)
  rememberQueueTransition(browserSessionStorage(), pb.authStore.model?.id, to, from, {
    left: window.scrollX,
    top: window.scrollY,
    todoPath: todoReturn ? router.resolve(todoReturn).fullPath : undefined
  })
  return null
})

export default router
