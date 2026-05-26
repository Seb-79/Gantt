// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import CreateProjectDialog from './CreateProjectDialog'

describe('CreateProjectDialog (v2.3 / RG-GANTT-2100)', () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null
  beforeEach(() => {
    // Fige today à une date stable pour vérifier le défaut.
    const fixed = new Date('2026-05-15T00:00:00.000Z').getTime()
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixed)
  })
  afterEach(() => {
    cleanup()
    dateNowSpy?.mockRestore()
  })

  it('ne rend rien quand open=false', () => {
    render(
      <CreateProjectDialog open={false} onCreate={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("propose 'Nouveau projet' et today comme valeurs par défaut", () => {
    render(<CreateProjectDialog open onCreate={vi.fn()} onClose={vi.fn()} />)
    const name = screen.getByLabelText(/nom du projet/i) as HTMLInputElement
    const date = screen.getByLabelText(/date de démarrage/i) as HTMLInputElement
    expect(name.value).toBe('Nouveau projet')
    expect(date.value).toBe('2026-05-15')
  })

  it('appelle onCreate avec les valeurs saisies au clic Créer', () => {
    const onCreate = vi.fn()
    render(<CreateProjectDialog open onCreate={onCreate} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/nom du projet/i), {
      target: { value: 'Mon projet' },
    })
    fireEvent.change(screen.getByLabelText(/date de démarrage/i), {
      target: { value: '2026-09-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: /créer/i }))
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Mon projet',
      project_start_date: '2026-09-01',
    })
  })

  it('désactive Créer si le nom est vide', () => {
    render(<CreateProjectDialog open onCreate={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/nom du projet/i), {
      target: { value: '   ' },
    })
    expect(screen.getByRole('button', { name: /créer/i })).toBeDisabled()
  })

  it('appelle onClose au clic Annuler', () => {
    const onClose = vi.fn()
    render(<CreateProjectDialog open onCreate={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /annuler/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
