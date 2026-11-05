import React from 'react';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'primary' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

const icons = {
  danger: (
    <svg className="confirm-icon danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
  warning: (
    <svg className="confirm-icon warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  primary: (
    <svg className="confirm-icon success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
};

export function ConfirmDialog({ open, title, message, confirmText = '确认', cancelText = '取消', variant = 'danger', onConfirm, onCancel }: Props) {
  return (
    <Modal open={open} onClose={onCancel} title="" className="confirm-dialog"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel}>{cancelText}</button>
          <button className={`btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>{confirmText}</button>
        </>
      }
    >
      <div className="confirm-dialog-content">
        {icons[variant]}
        <h4>{title}</h4>
        <p>{message}</p>
      </div>
    </Modal>
  );
}
