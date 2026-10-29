export type TotalrecallState = {
  session: { isOn: boolean }
  memory: { hasTools: boolean }
}

export const initialState: TotalrecallState = { session: { isOn: false }, memory: { hasTools: false } }
